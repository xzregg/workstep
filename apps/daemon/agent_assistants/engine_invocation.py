"""One assistant engine turn: capabilities, spawn options, events and approvals."""

import asyncio
import uuid
from typing import Any, Awaitable, Callable

from engines.core.events import InternalEvent, is_commentary
from engines.core.schema import EngineImage
from services.chat_permissions import (
    map_permission_overrides,
    map_plan_mode_overrides,
    parse_goal_command,
    PLAN_MODE_INSTRUCTION,
)
from services.intervention import intervention_manager


async def run_engine_turn(
    engine_id: str,
    model: str | None,
    cwd: str,
    prompt: str,
    session_id: str | None,
    on_event: Callable[[InternalEvent], Awaitable[None]] | None = None,
    *,
    engine_factory: Callable[[str], Any],
    settings_store: Any,
    spawner: Callable[[object], object] | None = None,
    error_prefix: str = "LLM engine failed",
    run_key: str | None = None,
    running_engines: dict[str, object] | None = None,
    assign_session_on_no_resume: bool = False,
    message_history: list | None = None,
    images: list[EngineImage] | None = None,
    report_engine_state: bool = False,
    thinking_effort: str | None = None,
    permission_mode: str | None = None,
    plan_mode: bool | None = None,
    goal_mode: bool | None = None,
    workstep_tools: bool = False,
    config_overrides: dict | None = None,
    live_message_queue: asyncio.Queue | None = None,
) -> tuple[str, list[dict], str | None]:
    """Run one engine turn; stream events; return (text, events, session_id).

    Shared by every assistant. ``spawner`` defaults to ``engine.spawn``;
    task-style assistants may pass a custom spawner (e.g.
    ``spawn_coordinator``, closing over its own images). When
    ``running_engines`` is given, the engine instance is tracked under
    ``run_key`` so callers can stop it. ``workstep_tools`` asks the engine to
    load the WorkStep internal tools natively (when it can host them); a
    custom ``spawner`` receives it as ``spawner(engine, workstep_tools=True)``.
    ``config_overrides`` merges into the engine's dynamic config (e.g. the
    built-in Pydantic AI engine's per-assistant provider).
    """
    engine = await asyncio.to_thread(engine_factory, engine_id)
    if engine is None:
        raise RuntimeError(f"{error_prefix} is unavailable: {engine_id}")
    if permission_mode:
        await engine.set_permission_mode(permission_mode)
    if images:
        capabilities = getattr(engine, "capabilities", None)
        engine_accepts_images = bool(
            getattr(capabilities, "supports_vision", False)
        )
        supports_multimodal = getattr(
            settings_store,
            "model_supports_multimodal",
            None,
        )
        provider_id = str((config_overrides or {}).get("provider_id") or "")
        model_accepts_images = (
            await asyncio.to_thread(
                supports_multimodal, engine_id, model or "", provider_id
            )
            if callable(supports_multimodal)
            else engine_accepts_images
        )
        if not (engine_accepts_images and model_accepts_images):
            prompt = engine.render_image_prompt(prompt, images)
            images = None
    supports_native_plan_mode = bool(
        getattr(getattr(engine, "capabilities", None), "supports_plan_mode", False)
    )
    goal_command = parse_goal_command(prompt)
    if goal_mode and goal_command is None:
        goal_command = ("start", prompt)
    if goal_command:
        if plan_mode:
            raise ValueError("目标模式不能与计划模式同时启用")
        if not getattr(getattr(engine, "capabilities", None), "supports_goal_mode", False):
            raise ValueError(f"当前引擎不支持目标模式：{engine_id}")
        goal_action, prompt = goal_command
        if goal_action != "start" and not session_id:
            raise ValueError("当前会话还没有可操作的目标")
        if goal_action == "start" and not prompt.strip():
            raise ValueError("目标内容不能为空")
    if plan_mode and not supports_native_plan_mode and prompt.strip() != "/compact":
        prompt = f"{prompt}\n\n{PLAN_MODE_INSTRUCTION}"
    content: list[str] = []
    events: list[dict] = []
    resolved_session_id = session_id
    error: str | None = None
    try:
        if running_engines is not None and run_key is not None:
            running_engines[run_key] = engine
        spawn_kwargs: dict[str, object] = {}
        load_workstep_tools = bool(
            workstep_tools
            and getattr(
                getattr(engine, "capabilities", None),
                "supports_workstep_tools",
                False,
            )
        )
        if load_workstep_tools:
            spawn_kwargs["workstep_tools"] = True
        if engine.supports_message_history:
            if message_history is not None:
                spawn_kwargs["message_history"] = message_history
            if report_engine_state:
                spawn_kwargs["report_engine_state"] = True
        if images:
            spawn_kwargs["images"] = images
        if (
            live_message_queue is not None
            and getattr(
                getattr(engine, "capabilities", None),
                "supports_live_step_message",
                False,
            )
        ):
            spawn_kwargs["live_message_queue"] = live_message_queue
        if (
            getattr(
                getattr(engine, "capabilities", None),
                "supports_thinking_effort",
                False,
            )
            and thinking_effort
        ):
            spawn_kwargs["thinking_effort"] = thinking_effort
        merged_overrides = dict(config_overrides or {})
        if permission_mode:
            merged_overrides.update(
                map_permission_overrides(engine_id, permission_mode)
            )
        if plan_mode:
            merged_overrides.update(map_plan_mode_overrides(engine_id))
        if supports_native_plan_mode:
            spawn_kwargs["plan_mode"] = bool(plan_mode)
        if goal_command:
            spawn_kwargs["goal_action"] = goal_action
        if merged_overrides:
            spawn_kwargs["config_overrides"] = merged_overrides
        if prompt.strip() == "/compact":
            spawner = None
        if spawner is None:
            iterator = getattr(engine, "spawn_with_retry", engine.spawn)(
                prompt=prompt,
                cwd=cwd,
                model=model,
                session_id=session_id if engine.supports_resume else None,
                **spawn_kwargs,
            )
        elif workstep_tools:
            iterator = spawner(
                engine,
                workstep_tools=True,
                config_overrides=merged_overrides or None,
            )
        else:
            iterator = spawner(engine, config_overrides=merged_overrides or None)
        async for event in iterator:
            normalize_event = getattr(
                engine,
                "normalize_event",
                getattr(engine, "normalize_interaction_event", None),
            )
            if normalize_event is not None:
                event = normalize_event(event)
            if event is None:
                continue
            interaction_waiter: asyncio.Task | None = None
            if event.type == "interaction_request":
                interaction_id = str(
                    event.data.get("interaction_id") or uuid.uuid4()
                )
                event.data["interaction_id"] = interaction_id
                interaction_waiter = asyncio.create_task(
                    intervention_manager.request_response(
                        interaction_id,
                        run_key or engine_id,
                        "assistant",
                        event.data,
                    )
                )
                # Register before publishing to avoid a fast-response race.
                await asyncio.sleep(0)
            events.append(event.to_dict())
            if on_event is not None:
                await on_event(event)
            if event.type == "agent_message_chunk" and not is_commentary(event):
                content_block = event.data.get("content") or {}
                content.append(str(content_block.get("text", "")))
            elif event.type == "session_started":
                resolved_session_id = (
                    str(event.data.get("session_id") or "") or None
                )
            elif event.type == "usage_update" and event.data.get("session_id"):
                resolved_session_id = str(event.data["session_id"])
            elif event.type == "error" and error is None:
                error = str(event.data.get("message") or f"{error_prefix} failed")
            if interaction_waiter is not None:
                response = await interaction_waiter
                if response.get("error"):
                    response = (
                        {"outcome": {"outcome": "cancelled"}}
                        if event.data.get("method") == "session/request_permission"
                        else {"action": "cancel"}
                    )
                await engine.respond_interaction(event.data, response)
                response_event = InternalEvent(
                    type="interaction_response",
                    data={
                        "interaction_id": event.data["interaction_id"],
                        "method": event.data.get("method"),
                        "response": response,
                    },
                )
                events.append(response_event.to_dict())
                if on_event is not None:
                    await on_event(response_event)
    finally:
        if running_engines is not None and run_key is not None:
            running_engines.pop(run_key, None)
    if (
        resolved_session_id is None
        and assign_session_on_no_resume
        and not engine.supports_resume
    ):
        resolved_session_id = str(uuid.uuid4())
    if error:
        raise RuntimeError(error)
    return "".join(content).strip(), events, resolved_session_id
