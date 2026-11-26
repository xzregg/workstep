"""Official Antigravity ACP: preserve the host CLI's sign-in and settings.

The CLI owns keyring access. WorkStep neither reads IDE credential databases
nor copies tokens; account models arrive through ACP session configuration.
"""
import os
import shutil
import sys
import asyncio
import logging
import re
from contextlib import aclosing, suppress
from pathlib import Path
from urllib.parse import urlsplit

import acp
from engines.core.acp_base import AcpEngineBase
from engines.core.acp_streaming_client import ACPStreamingClient as _StreamingClient
from engines.core.base import (
    EngineConfigField,
    EngineConfigOption,
    EngineModel,
    resolve_thinking_effort,
)
from engines.core.events import InternalEvent, compacted_event
from engines.core.packages import RuntimePackage
from engines.core.permissions import EnginePermissionPolicy
from engines.core.plans import plan_event, subagent_event
from engines.core.login import EngineLoginSession
from engines.core.process_cleanup import finish_cleanup, terminate_owned_process
from engines.core.schema import EngineImage
from engines.core.session_pool import exclusive_engine_run
from engines.core.stream_lines import iter_stream_chunks
from services import antigravity_runtime
from services.config import config_store
from settings import settings

logger = logging.getLogger(__name__)

_THOUGHT_LEVEL_LABELS = {
    "low": "低",
    "medium": "中",
    "high": "高",
    "xhigh": "极高",
}
_STEP_STATUS_MAP = {
    "pending": "pending",
    "in_progress": "in_progress",
    "inprogress": "in_progress",
    "done": "completed",
    "completed": "completed",
    "skipped": "completed",
    "failed": "completed",
}


def _extract_thought_levels(config_options) -> tuple[bool, list[str]]:
    option = next(
        (item for item in (config_options or []) if getattr(item, "id", None) == "thought_level"),
        None,
    )
    if option is None:
        return False, []
    values: list[str] = []
    for choice in getattr(option, "options", None) or []:
        nested = getattr(choice, "options", None)
        items = nested if nested is not None else [choice]
        for item in items:
            value = str(getattr(item, "value", "") or "").strip().lower()
            if value and value not in values:
                values.append(value)
    return True, values


def _map_antigravity_thought_level(effort: str, supported: list[str] | tuple[str, ...]) -> str | None:
    if effort in supported:
        return effort
    if effort == "minimal" and "low" in supported:
        return "low"
    if effort == "xhigh" and "high" in supported:
        return "high"
    return None


def _antigravity_prompt(raw_input: object) -> str | None:
    if not isinstance(raw_input, dict):
        return None
    for key in ("Prompt", "prompt", "Message", "message"):
        value = raw_input.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _is_antigravity_subagent_tool(title: str | None, raw_input: object) -> bool:
    normalized = "".join(ch for ch in str(title or "").lower() if ch.isalnum())
    if normalized in {"invokesubagent", "runinvokesubagent"}:
        return True
    if isinstance(raw_input, dict) and {"TypeName", "Role", "Prompt"} <= set(raw_input):
        return True
    return False


def _antigravity_plan_event(title: str | None, raw_input: object) -> InternalEvent | None:
    normalized = "".join(ch for ch in str(title or "").lower() if ch.isalnum())
    if normalized not in {"updatesteps", "runupdatesteps"} or not isinstance(raw_input, dict):
        return None
    steps = raw_input.get("steps")
    if not isinstance(steps, list):
        return None
    entries = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        content = str(step.get("title") or step.get("content") or "").strip()
        if not content:
            continue
        raw_status = str(step.get("status") or "pending").replace("-", "_").lower()
        entries.append({
            "content": content,
            "priority": str(step.get("priority") or "medium"),
            "status": _STEP_STATUS_MAP.get(raw_status, "pending"),
        })
    return plan_event(entries)


def _tool_output_text(data: dict) -> str:
    raw_output = data.get("raw_output")
    if isinstance(raw_output, str) and raw_output.strip():
        return raw_output.strip()
    if isinstance(raw_output, dict):
        for key in ("text", "output", "result", "summary", "message"):
            value = raw_output.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    content = data.get("content")
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            block = item.get("content") if isinstance(item.get("content"), dict) else item
            text = block.get("text") if isinstance(block, dict) else None
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())
        if parts:
            return "\n".join(parts)
    if raw_output not in (None, ""):
        return str(raw_output)
    return ""


class AntigravityEngine(AcpEngineBase):
    ENGINE_ID = "antigravity"
    SUPPORTS_QUOTA = True
    SUPPORTS_LOGIN = True
    SUPPORTS_MANUAL_COMPACTION = True
    LOGIN_TIMEOUT_SECONDS = 300
    _login_revision = 0
    PERMISSION_MODES = {"default", "auto", "accept-edits", "plan", "bypassPermissions"}
    THINKING_EFFORTS = ("low", "medium", "high", "xhigh")
    COMMAND = ["agy", "acp"]
    RUNTIME_PACKAGE = RuntimePackage("antigravity-cli", "native")
    PERMISSION_POLICY = EnginePermissionPolicy(
        overrides={"ask": {"permission_mode": "default"},
                   "danger-full-access": {"permission_mode": "bypassPermissions"}},
        plan_overrides={"permission_mode": "plan"},
        consent_key="permission_mode", consent_default="default",
        consent_values={"default": None, "bypassPermissions": True},
    )
    # session/load replays historical content; WorkStep already owns that history.
    DROP_REPLAYED_HISTORY_ON_RESUME = True
    QUOTA_TIMEOUT_SECONDS = 12

    def create_login_session(self):
        binary = self.resolve_binary()
        if not binary:
            raise ValueError('Antigravity is not installed')
        return _AntigravityLogin(binary, self.LOGIN_TIMEOUT_SECONDS, self._login_completed)

    @staticmethod
    def _login_completed():
        from services import engine_quota as engine_quota_service
        config_store.clear_engine_models('antigravity')
        config_store.set_engine_verified('antigravity', False)
        AntigravityEngine._login_revision += 1
        engine_quota_service.unified_quota_service.invalidate()

    def project_skill_env(self, cwd):
        return {**super().project_skill_env(cwd),
                'WORKSTEP_ENGINE_LOGIN_REVISION': str(self._login_revision)}

    async def get_quota(self, cwd=""):
        from engines.core.antigravity_quota import read_quota
        binary = await asyncio.to_thread(self.resolve_binary)
        return await read_quota(binary, cwd, self.QUOTA_TIMEOUT_SECONDS) if binary else None

    @classmethod
    def get_binary_override(cls):
        return super().get_binary_override() or os.getenv("ANTIGRAVITY_BIN") or None

    @staticmethod
    def resolve_binary():
        override = AntigravityEngine.get_binary_override()
        if override is not None:
            return override if os.path.isfile(override) else None
        managed = antigravity_runtime.managed_binary()
        if managed.is_file():
            return str(managed)
        binary = shutil.which("agy")
        if binary:
            return binary
        candidates = [Path.home() / ".local" / "bin" / "agy"]
        if sys.platform == "win32":
            candidates.insert(0, Path(os.getenv("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "agy" / "bin" / "agy.exe")
        return next((str(path) for path in candidates if path.is_file()), None)

    @staticmethod
    def is_installed():
        return AntigravityEngine.resolve_binary() is not None

    @staticmethod
    def is_configured():
        # Cached OAuth/keyring/API/enterprise credentials belong to the CLI.
        # The normal connection test verifies that authentication actually works.
        return AntigravityEngine.is_installed()

    @staticmethod
    def get_version():
        binary = AntigravityEngine.resolve_binary()
        if not binary:
            return None
        return antigravity_runtime.binary_version(Path(binary))

    def get_command(self):
        binary = self.resolve_binary()
        if not binary:
            return []
        command = [binary, "acp"]
        if self.get_permission_mode() == "auto":
            command.append("--dangerously-skip-permissions")
        return command

    def get_permission_mode(self):
        config = getattr(self, "_active_permission_config", None)
        if config is None:
            config = self._permission_config()
        return "auto" if config["permission_mode"] == "bypassPermissions" else "ask"

    def runtime_permission_decision(self):
        config = getattr(self, "_active_permission_config", None)
        if config is not None:
            return self.configured_permission_decision(config)
        return super().runtime_permission_decision()

    @classmethod
    def config_schema(cls):
        return [
            EngineConfigField(
                key="permission_mode", label="权限模式", type="select", category="mode",
                options=(EngineConfigOption("default", "跟随 Antigravity 规则"),
                         EngineConfigOption("auto", "自动审核"),
                         EngineConfigOption("accept-edits", "自动编辑"),
                         EngineConfigOption("plan", "计划模式"),
                         EngineConfigOption("bypassPermissions", "全权限（免审批）")),
                default="default", required=True, confirm_values=("bypassPermissions",),
                help="自动审核由引擎判断安全操作；自动编辑仅放行工作区编辑；计划模式由聊天计划开关控制；全权限免审批。",
            ),
            EngineConfigField(
                key="thinking_effort",
                model_capability="supported_reasoning_efforts",
                label="思考强度",
                type="select",
                options=tuple(
                    EngineConfigOption(level, _THOUGHT_LEVEL_LABELS[level])
                    for level in cls.THINKING_EFFORTS
                ),
                placeholder="默认不覆盖",
                help="默认思考深度（thought_level）；未选择时跟随模型默认。",
            ),
        ]

    def get_config_values(self):
        mode = config_store.get("antigravity_permission_mode", "default")
        raw_engine = config_store.get("antigravity_engine", {})
        effort = str(raw_engine.get("thinking_effort") or "").strip().lower() if isinstance(raw_engine, dict) else ""
        return {
            "permission_mode": mode if mode in self.PERMISSION_MODES else "default",
            "thinking_effort": effort if effort in self.THINKING_EFFORTS else "",
        }

    async def save_config_values(self, values, clear=None, confirmed=None):
        clear = clear or {}
        confirmed = confirmed or {}
        if "permission_mode" in values or clear.get("permission_mode"):
            mode = "default" if clear.get("permission_mode") else values["permission_mode"]
            if mode not in self.PERMISSION_MODES:
                raise ValueError("Unsupported Antigravity permission mode")
            if mode == "bypassPermissions" and not confirmed.get("permission_mode"):
                raise ValueError("Full access requires explicit risk confirmation")
            await asyncio.to_thread(config_store.set, "antigravity_permission_mode", mode)
            self.configure_interaction_policy({"permission_mode": mode})
        if "thinking_effort" in values or clear.get("thinking_effort"):
            effort = "" if clear.get("thinking_effort") else str(values.get("thinking_effort") or "").strip().lower()
            if effort == "auto":
                effort = ""
            if effort and effort not in self.THINKING_EFFORTS:
                raise ValueError("Unsupported Antigravity thinking effort")
            def save_effort():
                existing = config_store.get("antigravity_engine", {})
                updated = dict(existing) if isinstance(existing, dict) else {}
                updated["thinking_effort"] = effort
                config_store.set("antigravity_engine", updated)
            await asyncio.to_thread(save_effort)

    async def list_models(self, cwd: str) -> list[EngineModel]:
        """Read account models and each model's supported thought_level options."""
        cmd = await asyncio.to_thread(self.get_command)
        if not cmd:
            return []
        handler = _StreamingClient()
        async with acp.spawn_agent_process(
            handler,
            cmd[0],
            *cmd[1:],
            cwd=cwd,
            env=os.environ,
        ) as (client, process):
            self._process = process
            self._running = True
            try:
                self._initialize_response = await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_capabilities=self._client_capabilities(),
                    client_info={"name": "WorkStep", "version": settings.version},
                )
                session = await client.new_session(
                    cwd=cwd,
                    additional_directories=[],
                    mcp_servers=[],
                )
                session_id = getattr(session, "session_id", None)
                session_options = getattr(session, "config_options", None) or []
                model_option = next(
                    (option for option in session_options if getattr(option, "id", None) == "model"),
                    None,
                )
                if model_option is None:
                    return []
                has_initial_tl, initial_levels = _extract_thought_levels(session_options)
                can_probe_model = bool(session_id and callable(getattr(client, "set_config_option", None)))
                models: list[EngineModel] = []
                for option in model_option.options:
                    nested = getattr(option, "options", None)
                    choices = nested if nested is not None else [option]
                    for choice in choices:
                        supported = initial_levels if has_initial_tl and initial_levels else None
                        if can_probe_model:
                            try:
                                resp = await client.set_config_option(
                                    config_id="model",
                                    session_id=session_id,
                                    value=choice.value,
                                )
                                has_tl, levels = _extract_thought_levels(getattr(resp, "config_options", None))
                                supported = levels if has_tl and levels else None
                            except Exception:
                                logger.debug("Failed to probe thought_level for model %s", choice.value)
                        models.append(
                            EngineModel(
                                id=choice.value,
                                label=choice.name,
                                description=choice.description,
                                supported_reasoning_efforts=supported,
                            )
                        )
                if session_id and callable(getattr(client, "close_session", None)):
                    with suppress(Exception):
                        await client.close_session(session_id=session_id)
                return models
            finally:
                self._running = False
                self._process = None

    def _permission_config(self, overrides=None):
        config = self.get_config_values()
        config.update(self.permission_config_overrides(self.runtime_permission_mode() or ""))
        config = self.merge_config_overrides(config, overrides)
        if config["permission_mode"] not in self.PERMISSION_MODES:
            raise ValueError("Unsupported Antigravity permission mode")
        effort = str(config.get("thinking_effort") or "").strip().lower()
        if effort == "auto":
            effort = ""
        if effort and effort not in self.THINKING_EFFORTS:
            raise ValueError("Unsupported Antigravity thinking effort")
        config["thinking_effort"] = effort
        return config

    async def spawn(self, *args, config_overrides=None, plan_mode=None, **kwargs):
        # Resolve disk-backed defaults off-loop. Step > session > engine default.
        config = await asyncio.to_thread(self._permission_config, config_overrides)
        if plan_mode is True:
            config["permission_mode"] = "plan"
        elif plan_mode is False and config["permission_mode"] == "plan":
            config["permission_mode"] = "default"
        if getattr(self, "_engine_run_active", False):
            raise RuntimeError("A same engine instance is already running")
        previous = getattr(self, "_active_permission_config", None)
        previous_decision = getattr(self, "_interaction_policy_decision", None)
        previous_interaction = getattr(self, "_interaction_effective_config", None)
        previous_subagents = getattr(self, "_subagent_calls", None)
        self._active_permission_config = config
        self._subagent_calls = {}
        self.configure_interaction_policy(config)
        try:
            async with aclosing(
                self._spawn_with_live_interrupt(
                    *args,
                    config_overrides=config_overrides,
                    plan_mode=plan_mode,
                    **kwargs,
                )
            ) as stream:
                async for event in stream:
                    yield event
        finally:
            self._active_permission_config = previous
            self._interaction_policy_decision = previous_decision
            self._interaction_effective_config = previous_interaction
            self._subagent_calls = previous_subagents

    @exclusive_engine_run
    async def _spawn_with_live_interrupt(
        self,
        prompt: str,
        cwd: str,
        model: str | None = None,
        add_dirs: list[str] | None = None,
        session_id: str | None = None,
        images: list[EngineImage] | None = None,
        live_message_queue: asyncio.Queue | None = None,
        config_overrides: dict | None = None,
        thinking_effort: str | None = None,
        plan_mode: bool | None = None,
        goal_action: str | None = None,
    ):
        """Antigravity ACP execution with native thought_level and mid-run live-message interrupt."""
        if goal_action and not self.supports_goal_mode:
            yield InternalEvent(type="error", data={
                "message": f"Current engine does not support target mode: {self.ENGINE_ID}",
            })
            return
        if prompt.strip() == "/compact":
            if not session_id:
                yield InternalEvent(type="error", data={"message": "No compressible ACP session"})
                return
            commands = await self._inspect_acp_commands(cwd)
            if not any(command["name"] == "compact" for command in commands):
                yield InternalEvent(type="error", data={
                    "message": "ACP engine does not declare the /compact command",
                })
                return

        def prepare_spawn():
            provider_runtime = self.resolve_provider_runtime(
                provider_id=str((config_overrides or {}).get("provider_id") or ""),
                model=model,
            )
            return (
                provider_runtime,
                self.project_skill_env(cwd),
                self.get_command(),
                self.get_permission_mode(),
            )

        provider_runtime, skill_env, cmd, permission_mode = await asyncio.to_thread(prepare_spawn)
        model = provider_runtime.model
        if not cmd:
            yield InternalEvent(type="error", data={"message": f"{self.ENGINE_ID}: no command configured"})
            return

        logger.info("ACP spawn: %s (cwd=%s)", " ".join(cmd), cwd)
        yield InternalEvent(type="status", data={"status": "initializing"})

        handler = _StreamingClient(
            self.runtime_permission_mode() or permission_mode,
            permission_decision=self.runtime_permission_decision,
        )
        self._handler = handler
        self._last_cwd = cwd
        try:
            process_env = (
                provider_runtime.child_env()
                if provider_runtime.provider_id or provider_runtime.has_execution_context or provider_runtime.env
                else dict(os.environ)
            )
            process_env.update(skill_env)
            from engines.core.acp_reuse import pooled_acp_process

            async with pooled_acp_process(
                self, handler, cmd, cwd=cwd, env=process_env, session_id=session_id,
                settings=(add_dirs, config_overrides, permission_mode),
            ) as (client, process):
                handler = self._handler
                self._process = process
                self._running = True

                init_resp = await client.initialize(
                    protocol_version=acp.PROTOCOL_VERSION,
                    client_capabilities=self._client_capabilities(),
                    client_info={"name": "WorkStep", "version": settings.version},
                )
                self._initialize_response = init_resp

                if (
                    init_resp is not None
                    and getattr(init_resp, "protocol_version", acp.PROTOCOL_VERSION) != acp.PROTOCOL_VERSION
                ):
                    raise RuntimeError(
                        f"Incompatible ACP protocol version: client={acp.PROTOCOL_VERSION}, agent={init_resp.protocol_version}"
                    )

                mcp_servers = list((config_overrides or {}).get("mcp_servers") or [])
                from services.connectors.runtime import acp_servers
                mcp_servers = acp_servers(mcp_servers)
                self._validate_session_inputs(init_resp, add_dirs or [], mcp_servers)

                session_options_cache = getattr(self, "_session_config_options", None)
                if session_options_cache is None:
                    session_options_cache = self._session_config_options = {}

                session_config_options = None
                if session_id:
                    try:
                        if self._agent_capability(init_resp, "load_session"):
                            restored = await client.load_session(
                                cwd=cwd,
                                session_id=session_id,
                                mcp_servers=mcp_servers,
                                additional_directories=add_dirs or [],
                            )
                        elif self._agent_capability(init_resp, "session_capabilities", "resume"):
                            restored = await client.resume_session(
                                cwd=cwd,
                                session_id=session_id,
                                mcp_servers=mcp_servers,
                                additional_directories=add_dirs or [],
                            )
                        else:
                            raise RuntimeError(
                                "ACP Agent does not declare support for session/load or session/resume"
                            )
                        active_session_id = session_id
                        session_config_options = (
                            getattr(restored, "config_options", None)
                            or session_options_cache.get(active_session_id)
                        )
                    except Exception as exc:
                        logger.warning("Failed to load session %s: %s", session_id, exc)
                        yield InternalEvent(type="error", data={
                            "message": f"Unable to restore ACP session {session_id}: {exc}",
                            "session_id": session_id,
                        })
                        return
                else:
                    session = await client.new_session(
                        cwd=cwd,
                        additional_directories=add_dirs or [],
                        mcp_servers=mcp_servers,
                    )
                    active_session_id = session.session_id
                    session_config_options = getattr(session, "config_options", None)

                if session_config_options is not None:
                    session_options_cache[active_session_id] = session_config_options

                yield InternalEvent(type="session_started", data={"session_id": active_session_id})

                if model:
                    try:
                        model_resp = await client.set_config_option(
                            config_id="model",
                            session_id=active_session_id,
                            value=model,
                        )
                        updated = getattr(model_resp, "config_options", None)
                        if updated is not None:
                            session_config_options = updated
                            session_options_cache[active_session_id] = updated
                    except Exception:
                        logger.warning("Failed to set model %s", model)

                await self._configure_session_mode(client, active_session_id, plan_mode)
                await self._configure_session_thinking_effort(
                    client, active_session_id, thinking_effort, session_config_options,
                )

                yield InternalEvent(type="status", data={"status": "running"})
                if images and not self._agent_capability(init_resp, "prompt_capabilities", "image"):
                    raise RuntimeError("ACP Agent does not declare support for image prompts")
                prompt_blocks = await asyncio.to_thread(self._acp_prompt_blocks, prompt, images)

                interrupt_state = {"requested": False}

                async def _drain_prompt(task: asyncio.Task):
                    while not task.done() or not handler.updates.empty():
                        if (
                            live_message_queue is not None
                            and not interrupt_state["requested"]
                            and not task.done()
                            and not live_message_queue.empty()
                        ):
                            interrupt_state["requested"] = True
                            try:
                                await client.cancel(session_id=active_session_id)
                                logger.info("Antigravity prompt interrupted by live message")
                            except Exception:
                                logger.warning(
                                    "Antigravity session/cancel failed, waiting for current turn to finish",
                                    exc_info=True,
                                )
                        try:
                            update = await asyncio.wait_for(handler.updates.get(), timeout=0.1)
                        except asyncio.TimeoutError:
                            continue
                        event = self._map_notification(update)
                        if event:
                            yield event

                prompt_task = asyncio.create_task(
                    client.prompt(session_id=active_session_id, prompt=prompt_blocks)
                )
                async for event in _drain_prompt(prompt_task):
                    yield event

                prompt_response = await prompt_task
                usage_event = self._map_prompt_response_usage(prompt_response)
                if usage_event:
                    yield usage_event
                stop_reason = str(getattr(prompt_response, "stop_reason", "end_turn") or "end_turn")
                if stop_reason == "cancelled":
                    if not (
                        interrupt_state["requested"]
                        and live_message_queue is not None
                        and not live_message_queue.empty()
                    ):
                        yield InternalEvent(type="status", data={"status": "stopped"})
                        return
                if stop_reason in {"max_tokens", "max_turn_requests", "refusal"}:
                    yield InternalEvent(type="error", data={
                        "message": f"ACP Agent stopped prematurely: {stop_reason}",
                        "stop_reason": stop_reason,
                    })
                    return
                if prompt.strip() == "/compact":
                    yield compacted_event()
                    yield InternalEvent(type="status", data={"status": "done"})
                    return

                if live_message_queue is not None:
                    while True:
                        live_items: list[tuple[str, str]] = []
                        while not live_message_queue.empty():
                            live_items.append(live_message_queue.get_nowait())
                        if not live_items:
                            break
                        injected = "\n\n".join(content for _, content in live_items)
                        for message_id, _ in live_items:
                            yield InternalEvent(type="live_message", data={
                                "message_id": message_id,
                                "status": "delivered",
                                "detail": "",
                            })
                        interrupt_state["requested"] = False
                        prompt_task = asyncio.create_task(
                            client.prompt(
                                session_id=active_session_id,
                                prompt=[acp.text_block(injected)],
                            )
                        )
                        async for event in _drain_prompt(prompt_task):
                            yield event
                        prompt_response = await prompt_task
                        usage_event = self._map_prompt_response_usage(prompt_response)
                        if usage_event:
                            yield usage_event
                        stop_reason = str(getattr(prompt_response, "stop_reason", "end_turn") or "end_turn")
                        if stop_reason == "cancelled" and not (
                            interrupt_state["requested"] and not live_message_queue.empty()
                        ):
                            yield InternalEvent(type="status", data={"status": "stopped"})
                            return
                        if stop_reason in {"max_tokens", "max_turn_requests", "refusal"}:
                            yield InternalEvent(type="error", data={
                                "message": f"ACP Agent stopped prematurely: {stop_reason}",
                                "stop_reason": stop_reason,
                            })
                            return

                yield InternalEvent(type="status", data={"status": "done"})
        except Exception as exc:
            logger.exception("ACP session error")
            yield InternalEvent(type="error", data={"message": str(exc)})
        finally:
            self._running = False
            self._process = None
            self._handler = None

    async def _configure_session_mode(self, client, session_id, plan_mode):
        mode = self._active_permission_config["permission_mode"]
        # ACP ignores the CLI's global --mode. Set the native session option on
        # every turn, so reused/restored sessions cannot retain a previous plan.
        # Fail visibly if the agent rejects the mode; never run with stale policy.
        await client.set_config_option(
            config_id="mode", session_id=session_id,
            value="default" if mode == "bypassPermissions" else mode,
        )

    async def _configure_session_thinking_effort(
        self,
        client,
        session_id: str,
        thinking_effort: str | None,
        config_options=None,
    ) -> None:
        config = getattr(self, "_active_permission_config", None) or {}
        effort = resolve_thinking_effort(thinking_effort, config.get("thinking_effort"))
        if not effort:
            return
        known_options = list(config_options) if config_options else []
        if known_options:
            has_tl, supported = _extract_thought_levels(known_options)
            if not has_tl or not supported:
                return
            mapped = _map_antigravity_thought_level(effort, supported)
            if not mapped:
                return
            await client.set_config_option(
                config_id="thought_level",
                session_id=session_id,
                value=mapped,
            )
            return
        mapped = _map_antigravity_thought_level(effort, self.THINKING_EFFORTS)
        if not mapped:
            return
        try:
            await client.set_config_option(
                config_id="thought_level",
                session_id=session_id,
                value=mapped,
            )
        except Exception:
            if mapped == "xhigh":
                try:
                    await client.set_config_option(
                        config_id="thought_level",
                        session_id=session_id,
                        value="high",
                    )
                    return
                except Exception:
                    pass
            logger.warning("Antigravity session rejected thought_level=%s", mapped)

    def _map_notification(self, update) -> InternalEvent | None:
        event = super()._map_notification(update)
        if event is None:
            return None
        calls = getattr(self, "_subagent_calls", None)
        if calls is None:
            calls = self._subagent_calls = {}
        if event.type == "tool_call":
            data = event.data
            raw_input = data.get("raw_input")
            mapped_plan = _antigravity_plan_event(data.get("title"), raw_input)
            if mapped_plan is not None:
                return mapped_plan
            if _is_antigravity_subagent_tool(data.get("title"), raw_input):
                tool_call_id = str(data.get("tool_call_id") or "")
                input_dict = raw_input if isinstance(raw_input, dict) else {}
                role = str(input_dict.get("Role") or input_dict.get("role") or "").strip() or None
                type_name = str(input_dict.get("TypeName") or input_dict.get("type_name") or "").strip() or None
                prompt = _antigravity_prompt(input_dict)
                description = role or type_name or str(data.get("title") or "subagent")
                meta = {
                    "description": description,
                    "agent_name": role or type_name,
                    "task_type": type_name,
                    "prompt": prompt,
                }
                if tool_call_id:
                    calls[tool_call_id] = meta
                frame = subagent_event(
                    task_id=tool_call_id or description,
                    status="running",
                    stage="started",
                    description=description,
                    tool_use_id=tool_call_id or None,
                    task_type=type_name,
                    agent_name=role or type_name,
                    prompt=prompt,
                )
                frame.data["event"] = event.to_dict()
                return frame
        elif event.type == "tool_call_update":
            data = event.data
            tool_call_id = str(data.get("tool_call_id") or "")
            raw_input = data.get("raw_input")
            meta = calls.get(tool_call_id)
            if meta is not None or _is_antigravity_subagent_tool(data.get("title"), raw_input):
                input_dict = raw_input if isinstance(raw_input, dict) else {}
                role = (meta or {}).get("agent_name") or str(input_dict.get("Role") or input_dict.get("role") or "").strip() or None
                type_name = (meta or {}).get("task_type") or str(input_dict.get("TypeName") or input_dict.get("type_name") or "").strip() or None
                prompt = (meta or {}).get("prompt") or _antigravity_prompt(input_dict)
                description = (meta or {}).get("description") or role or type_name or str(data.get("title") or "subagent")
                raw_status = str(data.get("status") or "").lower()
                terminal_map = {
                    "completed": "completed",
                    "failed": "failed",
                    "error": "failed",
                    "cancelled": "stopped",
                    "canceled": "stopped",
                }
                terminal = terminal_map.get(raw_status)
                output_text = _tool_output_text(data)
                if terminal and tool_call_id:
                    calls.pop(tool_call_id, None)
                frame = subagent_event(
                    task_id=tool_call_id or description,
                    status=terminal or "running",
                    stage="notification" if terminal else "progress",
                    description=description,
                    tool_use_id=tool_call_id or None,
                    task_type=type_name,
                    agent_name=role or type_name,
                    prompt=prompt,
                    summary=output_text[:500] if terminal and output_text else None,
                    result=output_text if terminal and output_text else None,
                )
                frame.data["event"] = event.to_dict()
                return frame
        return event

    @property
    def supports_thinking_effort(self):
        return True

    @property
    def supports_vision(self):
        return self._is_acp_native

    @property
    def supports_tool_approval(self):
        return self._is_acp_native

    @property
    def supports_plan_mode(self):
        return True

    @property
    def supports_session_fork(self):
        return False


class _AntigravityLogin(EngineLoginSession):
    """Keep the official code-paste process in the daemon's own environment.

    In a desktop sandbox the daemon and this child already run in the container;
    HOME is its persistent mount. Never export host keychain tokens or change HOME.
    """
    MAX_OUTPUT_BYTES = 256 * 1024

    def __init__(self, binary, timeout, on_success):
        super().__init__()
        self.binary = binary
        self.timeout = timeout
        self.on_success = on_success
        self.process = None
        self.task = None

    async def start(self):
        self.task = asyncio.create_task(self._run())

    async def _launch(self):
        self.process = await asyncio.create_subprocess_exec(
            self.binary, 'acp', '--login',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

    async def _run(self):
        phase, error = 'failed', 'login_failed'
        try:
            async with asyncio.timeout(self.timeout):
                launch = asyncio.create_task(self._launch())
                try:
                    await asyncio.shield(launch)
                except asyncio.CancelledError:
                    await finish_cleanup(launch)
                    raise
                output = bytearray()
                # Prompts need not end with a newline. Read bounded chunks rather
                # than readline(), retaining only temporary, private CLI output.
                async for chunk in iter_stream_chunks(self.process.stdout, 4096):
                    output.extend(chunk)
                    if len(output) > self.MAX_OUTPUT_BYTES:
                        error = 'login_output_limit'
                        break
                    if self.state.phase != 'starting':
                        continue
                    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output.decode(errors='replace'))
                    for match in re.finditer(r'https://[^\s<>]+(?=\s)', text):
                        url = match.group()
                        parsed = urlsplit(url)
                        if (parsed.hostname == 'accounts.google.com'
                                and parsed.username is None and parsed.password is None
                                and parsed.port in (None, 443)
                                and parsed.path in ('/o/oauth2/auth', '/o/oauth2/v2/auth')):
                            self.state.authorization_url = url
                    if (self.state.authorization_url and 'paste' in text.lower()
                            and 'authorization code' in text.lower()):
                        self.state.phase = 'waiting_code'
                else:
                    if await self.process.wait() == 0:
                        phase, error = 'succeeded', None
        except TimeoutError:
            error = 'login_timeout'
        except asyncio.CancelledError:
            phase, error = 'cancelled', None
        except Exception:
            # Native errors can contain tokens and account details. Expose only
            # stable error codes; never log raw output or submitted credentials.
            pass
        finally:
            try:
                if self.process:
                    await finish_cleanup(terminate_owned_process(self.process))
                if phase == 'succeeded':
                    await asyncio.to_thread(self.on_success)
            except Exception:
                phase, error = 'failed', 'login_failed'
            finally:
                self.state.phase = phase
                self.state.error = error
                self.state.authorization_url = None

    async def submit(self, code):
        code = code.strip()
        if not code or len(code) > 8192 or any(ord(c) < 32 or ord(c) == 127 for c in code):
            raise ValueError('Enter a single authorization code or callback URL')
        if self.state.phase != 'waiting_code' or not self.process or self.process.returncode is not None:
            raise ValueError('Login is not waiting for an authorization code')
        self.state.phase = 'submitting'
        self.state.authorization_url = None
        try:
            self.process.stdin.write((code + '\n').encode())
            await self.process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            raise ValueError('Login session expired; start again') from None

    async def cancel(self):
        if self.task and not self.task.done():
            self.task.cancel()
            await finish_cleanup(asyncio.gather(self.task, return_exceptions=True))
        if self.state.active:
            self.state.phase = 'cancelled'
            self.state.authorization_url = None

