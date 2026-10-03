"""Shared task-creation seam for REST requests and scheduled dispatch."""

from dataclasses import dataclass
from contextlib import nullcontext
from datetime import datetime

from services.config import DEFAULT_EXECUTION_ENGINE
from services.workflow_definition import WorkflowDefinition
from services.gateway_client.policy import require_managed_capability
from services.remote_access import get_current_actor


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
) -> TaskCreationResult:
    """Create one task and optionally start it using a single policy interface."""
    if execution_mode not in {"workflow", "immediate", "manual"}:
        raise ValueError(f"Invalid execution mode: {execution_mode}")
    require_managed_capability("task.create", creator_fields=creator_fields,
                               project_id=project_id)
    actor = get_current_actor()
    if actor is not None and actor.project_id is not None:
        cwd = None

    def persist(project):
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
        return created, should_start

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
