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
        raise ValueError(f"未知引擎: {engine}")
    allowed = {field.key for field in target.full_step_config_schema()}
    if (set(config) - allowed or any(not isinstance(k, str) or not isinstance(v, str)
                                   for k, v in config.items())):
        raise ValueError("步骤配置包含不支持的字段或非字符串值")


def prepare_execution_handoff(project, task, step, current: dict, target: dict,
                               context_mode: str = "smart") -> None:
    """Shared DB-thread handoff preparation for quick config and canvas saves."""
    if context_mode not in {"smart", "full", "none"}:
        raise ValueError("不支持的交接方式")
    previous = (Message.select().where(
        (Message.task == task) & (Message.step_key == step.step_key)
        & (Message.channel == "execution") & (Message.role == "assistant")
        & Message.run_status.in_(["succeeded", "completed"])
    ).order_by(Message.sequence.desc()).first())
    source_engine = str((previous.engine if previous else None) or step.engine or "")
    target_engine = resolve_execution_engine(target.get("engine"))
    old_provider = str((step.session_provider if step.session_id else
                        (current.get("config") or {}).get("provider_id")) or "").strip()
    new_provider = str((target.get("config") or {}).get("provider_id") or "").strip()
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
            raise ValueError("引擎不能为空")
        if context_mode not in {None, "smart", "full", "none"}:
            raise ValueError("不支持的交接方式")
        if any(not isinstance(key, str) or not isinstance(value, str) for key, value in config.items()):
            raise ValueError("步骤配置必须为字符串键值")
        def load_engine_fields():
            target_engine = create_engine(normalized_engine)
            if target_engine is None:
                raise ValueError(f"未知引擎: {normalized_engine}")
            return {field.key for field in target_engine.full_step_config_schema()}

        allowed_fields = await asyncio.to_thread(load_engine_fields)
        unknown_fields = sorted(set(config) - allowed_fields)
        if unknown_fields:
            raise ValueError(f"不支持的步骤配置字段: {', '.join(unknown_fields)}")

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
                raise RuntimeError("步骤执行中，不能修改引擎配置")
            target = {
                "engine": normalized_engine,
                "model": (model or "").strip(),
                "config": dict(config),
            }
            prepare_execution_handoff(_project, task, step, current_step, target, context_mode or "smart")
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
                raise RuntimeError("步骤执行中，不能修改引擎配置")
            from services.task_workflow_config import task_overrides, source_workflow, _store_delta
            target = self._find_step(source_workflow(_project, task), step_key)
            if target is None:
                raise ValueError("任务新增阶段没有主流程配置可恢复，请在任务流程中编辑")
            current = self._find_step(self._workflow_steps(_project, task), step_key) or {}
            step.execution_config_json = None
            step.pending_handoff_json = None
            prepare_execution_handoff(_project, task, step, current, target)
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
