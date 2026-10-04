"""Per-task step execution configuration and engine handoff."""

import asyncio
import json

from agent_assistants.context_handoff import append_handoff_log
from models import Message, Task, TaskStep
from services.config import resolve_execution_engine

ACTIVE_STEP_CONFIG_STATUSES = {"running", "retrying", "rework"}


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
            if step is None:
                raise ValueError(f"Step does not exist: {step_key}")
            workflow = self._workflow_steps(project, task)
            resolved_step = self._find_step(workflow, step_key)
            if resolved_step is None:
                raise ValueError(f"Step does not exist: {step_key}")
            configured = None
            if step.execution_config_json:
                try:
                    value = json.loads(step.execution_config_json)
                    configured = value if isinstance(value, dict) else None
                except (TypeError, json.JSONDecodeError):
                    configured = None
            resolved = {
                "engine": resolve_execution_engine(resolved_step.get("engine")),
                "model": str(resolved_step.get("model") or ""),
                "config": dict(resolved_step.get("config") or {}),
            }
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
            step = TaskStep.get_or_none(
                (TaskStep.task == task) & (TaskStep.step_key == step_key)
            )
            if step is None:
                raise ValueError(f"Step does not exist: {step_key}")
            if step.status in ACTIVE_STEP_CONFIG_STATUSES:
                raise RuntimeError("步骤执行中，不能修改引擎配置")
            previous = (
                Message.select()
                .where(
                    (Message.task == task)
                    & (Message.step_key == step_key)
                    & (Message.channel == "execution")
                    & (Message.role == "assistant")
                    & (Message.run_status.in_(["succeeded", "completed"]))
                )
                .order_by(Message.sequence.desc())
                .first()
            )
            source_engine = str(
                (previous.engine if previous is not None else None)
                or step.engine
                or ""
            )
            current_workflow = self._workflow_steps(_project, task)
            current_step = self._find_step(current_workflow, step_key) or {}
            current_provider = str(
                (current_step.get("config") or {}).get("provider_id") or ""
            ).strip()
            new_provider = str((config or {}).get("provider_id") or "").strip()
            # 同引擎但供应商变更也属于端点切换：只要步骤已有历史，就要生成
            # 交接数据。是否存在可复用 session 仅决定后续能否 resume，不影响
            # 用户对上下文交接方式的选择。
            provider_changed = (
                bool(source_engine)
                and source_engine == normalized_engine
                and current_provider != new_provider
            )
            previous_provider = current_provider if provider_changed else ""
            step.execution_config_json = json.dumps({
                "engine": normalized_engine,
                "model": (model or "").strip(),
                "config": dict(config),
            }, ensure_ascii=False, sort_keys=True)
            if source_engine and (
                source_engine != normalized_engine or provider_changed
            ):
                history = [
                    {
                        "id": row.id,
                        "role": row.role,
                        "content": row.content,
                        "status": row.run_status,
                        "created_at": (
                            row.created_at.isoformat() if row.created_at else None
                        ),
                    }
                    for row in (
                        Message.select()
                        .where(
                            (Message.task == task)
                            & (Message.step_key == step_key)
                            & (Message.channel == "execution")
                            & (Message.role.in_(["user", "assistant"]))
                        )
                        .order_by(Message.sequence.asc())
                    )
                ]
                if history:
                    metadata = append_handoff_log(
                        _project.workstep_dir,
                        f"task-{task.id}:{step_key}",
                        history,
                        source_engine=source_engine,
                        target_engine=normalized_engine,
                        mode=context_mode or "smart",
                        source_provider=previous_provider,
                        target_provider=new_provider,
                    )
                    step.pending_handoff_json = json.dumps(
                        metadata, ensure_ascii=False, sort_keys=True
                    )
            else:
                step.pending_handoff_json = None
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
            step.execution_config_json = None
            step.pending_handoff_json = None
            step.save(only=[TaskStep.execution_config_json, TaskStep.pending_handoff_json])

        lock = self._operation_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            await self._run_db(project_id, reset)
        return await self.get(project_id, task_id, step_key)
