"""Shared task-creation seam for REST requests and scheduled dispatch."""

import asyncio
from dataclasses import dataclass
from contextlib import nullcontext
from collections.abc import Callable
from datetime import datetime

from services.config import DEFAULT_EXECUTION_ENGINE
from services.workflow_definition import WorkflowDefinition
from services.gateway_client.policy import require_managed_capability
from services.remote_access import get_current_actor, replayed_actor_context


async def _require_scheduled_creation(
    project_id: str, creator_fields: dict | None, creator_source: str | None,
) -> None:
    """Recheck saved native device grants; never borrow the scheduler's actor."""
    from main import gateway_client, remote_access_service

    if gateway_client.managed_config is None:
        return

    def denied(detail):
        return PermissionError(f"Managed capability denied: task.create（{detail}）")

    if not creator_fields or not creator_fields.get("creator_id"):
        raise denied("定时规则缺少创建人身份，请由有任务创建权限的用户重新保存规则")
    if creator_source in {None, "remote"}:
        device_id = creator_fields.get("creator_device_id")

        def native_device_status():
            if not device_id:
                return None
            for device in remote_access_service.list_devices(project_id):
                if device["project_id"] == project_id and device["device_id"] == device_id:
                    return (device["status"] if remote_access_service.settings().get("enabled", False)
                            else "disabled")
            return None

        # Legacy schedules lack source metadata. A current project/device grant
        # is still required; being disconnected does not revoke that grant.
        status = await asyncio.to_thread(native_device_status)
        if status == "active":
            return
        if status is not None or creator_source == "remote":
            detail = {
                "disabled": "宿主已关闭远程项目访问",
                "revoked": "创建人设备的目标项目授权已撤销",
                "expired": "创建人设备的目标项目授权已过期",
            }.get(status, "找不到创建人设备的目标项目授权")
            raise denied(f"定时规则授权失效：{detail}")
    with replayed_actor_context(None):
        try:
            require_managed_capability("task.create", creator_fields=creator_fields,
                                       project_id=project_id)
        except PermissionError as exc:
            policy = gateway_client.policy_cache.current
            if policy is None:
                detail = "网关权限快照尚未就绪，请检查宿主的网关登录与连接"
            elif not policy.valid:
                detail = "网关权限快照已过期，请检查宿主的网关连接"
            elif policy.user_id != creator_fields["creator_id"]:
                detail = "定时规则创建人与当前网关用户不匹配，请由有任务创建权限的用户重新建立规则"
            else:
                detail = "定时规则创建人没有目标项目的任务创建权限"
            raise denied(detail) from exc


@dataclass(frozen=True)
class TaskCreationResult:
    task: dict
    run_handle: object | None


async def create_project_task(
    *,
    project_manager,
    task_service,
    workflow_runtime,
    project_id: str,
    title: str,
    cwd: str | None = None,
    description: str | None = None,
    engine: str = DEFAULT_EXECUTION_ENGINE,
    workflow_id: str | None = None,
    start_step_key: str | None = None,
    review_overrides: dict | None = None,
    execution_mode: str = "workflow",
    scheduled_start_at: datetime | None = None,
    source_dispatch_id: str | None = None,
    source_project_id: str | None = None,
    source_task_id: str | None = None,
    source_step_key: str | None = None,
    input_manifest: list[dict] | None = None,
    dispatch_lineage: list[str] | None = None,
    source: str = "manual",
    creator_fields: dict | None = None,
    creator_source: str | None = None,
    on_persisted: Callable[[dict], None] | None = None,
) -> TaskCreationResult:
    """Create one task and optionally start it using a single policy interface."""
    if execution_mode not in {"workflow", "immediate", "manual"}:
        raise ValueError(f"Invalid execution mode: {execution_mode}")
    if source == "schedule":
        await _require_scheduled_creation(project_id, creator_fields, creator_source)
    else:
        require_managed_capability("task.create", creator_fields=creator_fields,
                                   project_id=project_id)
    actor = get_current_actor()
    if actor is not None and actor.project_id is not None:
        cwd = None

    def persist_task(project):
        if workflow_id and hasattr(project, "workflow_by_id"):
            workflow = project.workflow_by_id(workflow_id)
        elif not workflow_id and hasattr(project, "default_workflow"):
            workflow = project.default_workflow()
        else:
            workflow = {"id": workflow_id, "steps": project.steps}
        if workflow is None:
            raise ValueError(
                "Workflow not found" if workflow_id else "No workflow exists"
            )
        definition = WorkflowDefinition.load(workflow["steps"])
        created = task_service.create_task(
            project_id=project_id,
            title=title,
            cwd=cwd or str(project.path),
            description=description,
            engine=engine,
            workflow=workflow["steps"],
            start_step_key=start_step_key,
            review_overrides=review_overrides,
            workflow_id=workflow["id"],
            scheduled_start_at=scheduled_start_at,
            source_dispatch_id=source_dispatch_id,
            source_project_id=source_project_id,
            source_task_id=source_task_id,
            source_step_key=source_step_key,
            input_manifest=input_manifest,
            dispatch_lineage=dispatch_lineage,
            creator_fields=creator_fields,
        )
        should_start = (
            execution_mode == "immediate"
            or (
                execution_mode == "workflow"
                and definition.auto_start_enabled(start_step_key)
            )
        )
        if on_persisted is not None:
            on_persisted(created)
        return created, should_start

    def persist(project):
        # A scheduler's task index must commit with the task itself, before any
        # immediate startup or cancellation can interrupt the caller.
        transaction = project.db.atomic() if on_persisted is not None else nullcontext()
        with transaction:
            return persist_task(project)

    if hasattr(project_manager, "run_db"):
        created, should_start = await project_manager.run_db(project_id, persist)
    else:
        context = (
            project_manager.activate_project_by_id(project_id)
            if hasattr(project_manager, "activate_project_by_id")
            else nullcontext(project_manager.bind_project_by_id(project_id))
        )
        with context as project:
            created, should_start = persist(project)

    handle = None
    if should_start:
        if workflow_runtime is None:
            raise RuntimeError("Workflow runtime not initialized")
        handle = await workflow_runtime.start(
            project_id, created["id"], "", source=source
        )
        context = (
            project_manager.activate_project_by_id(project_id)
            if hasattr(project_manager, "activate_project_by_id")
            else nullcontext(project_manager.bind_project_by_id(project_id))
        )
        if hasattr(project_manager, "run_db"):
            created = await project_manager.run_db(project_id, lambda _project:
                task_service.get_task(created["id"]) or created)
        else:
            with context:
                created = task_service.get_task(created["id"]) or created
    return TaskCreationResult(created, handle)
