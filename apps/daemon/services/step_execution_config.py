"""Per-task step execution configuration and engine handoff."""

import asyncio
import json

from agent_assistants.context_handoff import append_handoff_log
from models import Message, Task, TaskStep
from services.config import resolve_execution_engine

ACTIVE_STEP_CONFIG_STATUSES = {"running", "retrying", "rework"}


def validate_execution_config(engine: str | None, config: dict) -> None:
    from engines.core.registry import create_engine

    target = create_engine(resolve_execution_engine(engine))
    if target is None:
        raise ValueError(f"Unknown engine: {engine}")
    allowed = {field.key for field in target.full_step_config_schema()}
    if (set(config) - allowed or any(not isinstance(k, str) or not isinstance(v, str)
                                   for k, v in config.items())):
        raise ValueError("Step configuration contains unsupported fields or non-string values")


def prepare_execution_handoff(project, task, step, current: dict, target: dict,
                               context_mode: str = "smart") -> None:
    """Shared DB-thread handoff preparation for quick config and canvas saves."""
    if context_mode not in {"smart", "full", "none"}:
        raise ValueError("Unsupported handover method")
    previous = (Message.select().where(
        (Message.task == task) & (Message.step_key == step.step_key)
        & (Message.channel == "execution") & (Message.role == "assistant")
        & Message.run_status.in_(["succeeded", "completed"])
    ).order_by(Message.sequence.desc()).first())
    source_engine = str((previous.engine if previous else None) or step.engine or "")
    target_engine = resolve_execution_engine(target.get("engine"))
    old_provider = str((step.session_provider if step.session_provider is not None else
                        (current.get("config") or {}).get("provider_id")) or "").strip()
    new_provider = str((target.get("config") or {}).get("provider_id") or "").strip()
    if not new_provider:
        from engines.core.registry import create_engine
        resolver = getattr(create_engine(target_engine), "resolve_provider_id", None)
        if callable(resolver):
            new_provider = resolver("")
    if not source_engine or (source_engine == target_engine and old_provider == new_provider):
        # An unrelated draft save must not discard an already prepared handoff.
        return
    history = [{"id": row.id, "role": row.role, "content": row.content,
                "status": row.run_status, "created_at": row.created_at.isoformat() if row.created_at else None}
               for row in Message.select().where(
                   (Message.task == task) & (Message.step_key == step.step_key)
                   & (Message.channel == "execution") & Message.role.in_(["user", "assistant"])
               ).order_by(Message.sequence)]
    if history:
        metadata = append_handoff_log(
            project.workstep_dir, f"task-{task.id}:{step.step_key}", history,
            source_engine=source_engine, target_engine=target_engine, mode=context_mode,
            source_provider=old_provider, target_provider=new_provider,
        )
        step.pending_handoff_json = json.dumps(metadata, ensure_ascii=False, sort_keys=True)


def prepare_current_step_handoff(project, task_id, step_key, workflow_steps, *, authorize=False):
    """DB-worker preflight; never changes configuration, sessions or run state."""
    from engines.core.registry import create_engine
    from services.config import config_store
    from agent_assistants.session_state import PROVIDER_HANDOFF_REQUIRED

    task = Task.get_or_none(Task.id == task_id)
    if task is None:
        raise ValueError(f"Task not found: {task_id}")
    target = StepExecutionConfigService._find_step(workflow_steps(project, task), step_key)
    step = TaskStep.get_or_none((TaskStep.task == task) & (TaskStep.step_key == step_key))
    if target is None or step is None:
        raise ValueError(f"Step does not exist: {step_key}")
    if step.status in {*ACTIVE_STEP_CONFIG_STATUSES, "reviewing", "rework_waiting"}:
        raise ValueError(f"Step cannot hand off at this time: {step_key} (current status {step.status})")
    engine_id = resolve_execution_engine(target.get("engine"))
    engine = create_engine(engine_id)
    if engine is None:
        raise ValueError(f"Unknown engine: {engine_id}")
    provider = str((target.get("config") or {}).get("provider_id") or "").strip()
    resolver = getattr(engine, "resolve_provider_id", None)
    provider = resolver(provider) if callable(resolver) else (provider or config_store.get_engine_provider(engine_id))
    provider = provider or ""
    pending = json.loads(step.pending_handoff_json or "null")
    if pending is not None and not isinstance(pending, dict):
        raise ValueError("Invalid pending handoff metadata")
    if (pending and pending.get("handoff_id")
            and pending.get("target_engine") == engine_id
            and (pending.get("target_provider") or "") == provider
            and (not authorize or pending.get("mode") == "smart")):
        return {"status": "prepared", "handoff_id": pending["handoff_id"], "next_actions": ["step-start"]}
    previous = Message.select().where((Message.task == task) & (Message.step_key == step_key)
        & (Message.channel == "execution") & (Message.role == "assistant")
        & Message.run_status.in_(["succeeded", "completed"])).order_by(Message.sequence.desc()).first()
    has_session = step.session_provider is not None or step.session_id or previous
    session_engine = (previous.engine if previous else step.engine) or engine_id
    provider_changed = (step.session_provider or "") != provider
    changed = bool(pending or (has_session and (
        provider_changed or (authorize and session_engine != engine_id)
    )))
    if not changed:
        return {"status": "not_required", "next_actions": ["step-start"]}
    if not authorize:
        from services.task_step_start import StepProviderHandoffRequired
        raise StepProviderHandoffRequired(PROVIDER_HANDOFF_REQUIRED)
    resolved = {**target, "engine": engine_id, "config": {**(target.get("config") or {}), "provider_id": provider}}
    prepare_execution_handoff(project, task, step, target, resolved, "smart")
    if not step.pending_handoff_json:
        raise ValueError("No execution history available for smart handoff; inspect the task before choosing a new session")
    metadata = json.loads(step.pending_handoff_json)
    if metadata.get("target_engine") != engine_id or (metadata.get("target_provider") or "") != provider:
        raise ValueError("Prepared handoff does not match the current execution provider")
    step.save(only=[TaskStep.pending_handoff_json])
    return {"status": "prepared", "handoff_id": metadata["handoff_id"], "next_actions": ["step-start"]}


class StepExecutionConfigService:
    def __init__(self, run_db, workflow_steps, operation_locks):
        self._run_db = run_db
        self._workflow_steps = workflow_steps
        self._operation_locks = operation_locks

    @staticmethod
    def _find_step(workflow_data: dict, step_key: str) -> dict | None:
        is_nodes = bool(workflow_data.get("nodes"))
        for item in workflow_data.get("nodes") or workflow_data.get("steps") or []:
            key = str(
                (item.get("type") or item.get("key") or item.get("id"))
                if is_nodes
                else (item.get("key") or item.get("id") or item.get("type"))
                or ""
            )
            if key == step_key:
                return item
        return None

    async def get(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
    ) -> dict:
        from engines.core.registry import get_available_engines

        def load(project):
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ValueError(f"Task not found: {task_id}")
            step = TaskStep.get_or_none(
                (TaskStep.task == task) & (TaskStep.step_key == step_key)
            )
            workflow = self._workflow_steps(project, task)
            resolved_step = self._find_step(workflow, step_key)
            if resolved_step is None:
                raise ValueError(f"Step does not exist: {step_key}")
            if step is None:
                # Main workflow additions are visible before their first run.
                step = TaskStep(task=task, step_key=step_key, status="pending")
            configured = None
            if step.execution_config_json:
                try:
                    value = json.loads(step.execution_config_json)
                    configured = value if isinstance(value, dict) else None
                except (TypeError, json.JSONDecodeError):
                    configured = None
            from services.task_workflow_config import task_overrides, source_workflow
            overlay = (task_overrides(task) or {}).get("nodes", {}).get(step_key, {})
            if not overlay:
                overlay = next((node for node in (task_overrides(task) or {}).get("added_nodes", [])
                                if node["type"] == step_key), {})
            if any(field in overlay for field in ("engine", "model", "config")):
                configured = {field: resolved_step.get(field) for field in ("engine", "model", "config")}
            resolved = {
                "engine": resolve_execution_engine(resolved_step.get("engine")),
                "model": str(resolved_step.get("model") or ""),
                "config": dict(resolved_step.get("config") or {}),
            }
            if configured is not None:
                configured = dict(resolved)
            execution_messages = Message.select().where(
                (Message.task == task)
                & (Message.step_key == step_key)
                & (Message.channel == "execution")
                & (Message.role.in_(["user", "assistant"]))
            )
            latest_response = (
                execution_messages.where(
                    (Message.role == "assistant")
                    & (Message.run_status.in_(["succeeded", "completed"]))
                )
                .order_by(Message.sequence.desc())
                .first()
            )
            return {
                "configured": configured,
                "resolved": resolved,
                "source": "task_override" if configured is not None else "workflow",
                "editable": step.status not in ACTIVE_STEP_CONFIG_STATUSES,
                "can_reset": self._find_step(source_workflow(project, task), step_key) is not None,
                "status": step.status,
                "has_history": execution_messages.exists(),
                "message_count": execution_messages.count(),
                "session_engine": str(
                    (latest_response.engine if latest_response is not None else None)
                    or step.engine
                    or resolved["engine"]
                ),
                # 当前引擎会话建立时绑定的供应商；null = 无可复用会话。
                # 同引擎换供应商时需要交接（旧会话端点与新供应商不匹配）。
                "session_provider": (
                    str(step.session_provider or "").strip()
                    if step.session_id else None
                ),
                "available_engines": get_available_engines(),
            }

        return await self._run_db(project_id, load)

    async def update(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        *,
        engine: str,
        model: str | None,
        config: dict[str, str],
        context_mode: str | None = None,
    ) -> dict:
        from engines.core.registry import create_engine

        normalized_engine = engine.strip()
        if not normalized_engine:
            raise ValueError("Engine cannot be empty")
        if context_mode not in {None, "smart", "full", "none"}:
            raise ValueError("Unsupported handover method")
        if any(not isinstance(key, str) or not isinstance(value, str) for key, value in config.items()):
            raise ValueError("Step configuration must be a string key-value")
        def load_engine_fields():
            target_engine = create_engine(normalized_engine)
            if target_engine is None:
                raise ValueError(f"Unknown engine: {normalized_engine}")
            return {field.key for field in target_engine.full_step_config_schema()}

        allowed_fields = await asyncio.to_thread(load_engine_fields)
        unknown_fields = sorted(set(config) - allowed_fields)
        if unknown_fields:
            raise ValueError(f"Unsupported step configuration field: {', '.join(unknown_fields)}")

        def save(_project):
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ValueError(f"Task not found: {task_id}")
            current_workflow = self._workflow_steps(_project, task)
            current_step = self._find_step(current_workflow, step_key)
            if current_step is None:
                raise ValueError(f"Step does not exist: {step_key}")
            step, _ = TaskStep.get_or_create(task=task, step_key=step_key, defaults={"status": "pending"})
            if step.status in ACTIVE_STEP_CONFIG_STATUSES:
                raise RuntimeError("Cannot modify engine configuration while steps are executing")
            target = {
                "engine": normalized_engine,
                "model": (model or "").strip(),
                "config": dict(config),
            }
            if context_mode is not None:
                prepare_execution_handoff(_project, task, step, current_step, target, context_mode)
            step.execution_config_json = None
            from services.task_workflow_config import set_execution_override
            set_execution_override(_project, task, step_key, target)
            task.state_version += 1
            task.save(only=[Task.workflow_overrides_json, Task.state_version])
            step.save(only=[
                TaskStep.execution_config_json,
                TaskStep.pending_handoff_json,
            ])

        lock = self._operation_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            await self._run_db(project_id, save)
        return await self.get(project_id, task_id, step_key)

    async def reset(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
    ) -> dict:
        def reset(_project):
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ValueError(f"Task not found: {task_id}")
            step = TaskStep.get_or_none(
                (TaskStep.task == task) & (TaskStep.step_key == step_key)
            )
            if step is None:
                raise ValueError(f"Step does not exist: {step_key}")
            if step.status in ACTIVE_STEP_CONFIG_STATUSES:
                raise RuntimeError("Cannot modify engine configuration while steps are executing")
            from services.task_workflow_config import task_overrides, source_workflow, _store_delta
            target = self._find_step(source_workflow(_project, task), step_key)
            if target is None:
                raise ValueError("No main process configuration available for recovery in the task creation phase. Please edit in the task flow.")
            step.execution_config_json = None
            step.pending_handoff_json = None
            delta = task_overrides(task)
            if delta:
                patch = delta.get("nodes", {}).get(step_key, {})
                for field in ("engine", "model", "config"):
                    patch.pop(field, None)
                if not patch:
                    delta.get("nodes", {}).pop(step_key, None)
                _store_delta(task, delta)
                task.state_version += 1
                task.save(only=[Task.workflow_overrides_json, Task.state_version])
            step.save(only=[TaskStep.execution_config_json, TaskStep.pending_handoff_json])

        lock = self._operation_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            await self._run_db(project_id, reset)
        return await self.get(project_id, task_id, step_key)
