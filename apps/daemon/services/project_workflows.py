"""Synchronous project workflow lifecycle and dependent schedule cleanup.

Callers run these database operations inside a project database work unit.
"""

from __future__ import annotations

import json
import uuid
from typing import TYPE_CHECKING

import peewee as pw

from models import (
    ActionProposal,
    CoordinatorSession,
    CoordinatorTurn,
    Message,
    ReviewRun,
    Schedule,
    StepRun,
    StepSupplement,
    Task,
    TaskStep,
    Workflow,
    WorkflowRun,
)
from models.fields import utc_now

if TYPE_CHECKING:
    from services.project import Project


class ProjectWorkflowService:
    """Manage one project's flows within its activated SQLite database."""

    def _load_workflows_from_db(self) -> list[dict]:
        """Load all workflow rows from the project DB into dicts."""
        rows = list(Workflow.select().order_by(Workflow.sort_order, Workflow.created_at))
        result = []
        for r in rows:
            try:
                steps = json.loads(r.steps_json)
            except (json.JSONDecodeError, TypeError):
                steps = {}
            result.append({
                "id": r.id,
                "name": r.name,
                "steps": steps,
                "is_default": bool(r.is_default),
                "deleted": bool(r.deleted),
                "created_at": r.created_at,
                "updated_at": r.updated_at,
            })
        return result

    def _sync_project_workflows(self, proj: Project) -> None:
        """Load workflows from DB into the Project dataclass and update cached steps."""
        proj.workflows = self._load_workflows_from_db()
        default = proj.default_workflow()
        if default:
            proj.steps = default["steps"]

    def create_workflow(self, proj: Project, name: str, steps: dict | None = None,
                        is_default: bool = False) -> dict:
        """Create a new workflow and return its dict."""
        if is_default:
            Workflow.update(is_default=0).where(Workflow.is_default == 1).execute()
        now = utc_now()
        wf_id = str(uuid.uuid4())[:8]
        wf_steps = steps if steps is not None else {"nodes": [], "connections": []}
        next_order = (Workflow.select(pw.fn.MAX(Workflow.sort_order)).scalar() or 0) + 1
        Workflow.create(
            id=wf_id, name=name,
            steps_json=json.dumps(wf_steps, ensure_ascii=False),
            is_default=1 if is_default else 0,
            sort_order=next_order,
            created_at=now, updated_at=now,
        )
        self._sync_project_workflows(proj)
        return next(w for w in proj.workflows if w["id"] == wf_id)

    def reorder_workflows(self, proj: Project, ordered_ids: list[str]) -> None:
        """Reassign sort_order from an explicit id list; unknown ids keep their relative order at the end."""
        rows = list(Workflow.select().order_by(Workflow.sort_order, Workflow.created_at))
        by_id = {row.id: row for row in rows}
        seen: set[str] = set()
        ordered: list[Workflow] = []
        for wf_id in ordered_ids:
            row = by_id.get(wf_id)
            if row is not None and wf_id not in seen:
                ordered.append(row)
                seen.add(wf_id)
        for row in rows:
            if row.id not in seen:
                ordered.append(row)
        for index, row in enumerate(ordered):
            if row.sort_order != index:
                row.sort_order = index
                row.save()
        self._sync_project_workflows(proj)

    def update_workflow(self, proj: Project, workflow_id: str,
                        name: str | None = None, steps: dict | None = None) -> dict | None:
        """Update a workflow's name and/or steps. Returns the updated dict or None."""
        row = Workflow.get_or_none(Workflow.id == workflow_id)
        if row is None:
            return None
        if name is not None:
            row.name = name
        if steps is not None:
            row.steps_json = json.dumps(steps, ensure_ascii=False)
        row.updated_at = utc_now()
        row.save()
        if steps is not None:
            self._invalidate_schedules_with_missing_start(workflow_id, steps)
        self._sync_project_workflows(proj)
        return next((w for w in proj.workflows if w["id"] == workflow_id), None)

    def _invalidate_schedules_with_missing_start(
        self, workflow_id: str, steps: dict
    ) -> None:
        from services.workflow_definition import WorkflowDefinition

        step_keys = {
            item["key"]
            for item in WorkflowDefinition.load(steps).compile().to_steps_config()["steps"]
        }
        for schedule in Schedule.select().where(
            (Schedule.workflow_id == workflow_id)
            & (Schedule.status.in_(("active", "paused")))
        ):
            try:
                start_key = json.loads(schedule.task_template_json).get("start_step_key")
            except (json.JSONDecodeError, TypeError):
                start_key = None
            if start_key and start_key not in step_keys:
                schedule.status = "invalid"
                schedule.invalid_reason = f"Start step was removed: {start_key}"
                schedule.next_run_at = None
                schedule.updated_at = utc_now()
                schedule.save()

    def delete_workflow(self, proj: Project, workflow_id: str) -> dict | None:
        """Delete a workflow — two-step (recycle bin).

        First call soft-deletes (row stays, `deleted=1`); deleting again
        permanently removes the row. The default workflow and the last
        remaining active workflow cannot be deleted.
        """
        row = Workflow.get_or_none(Workflow.id == workflow_id)
        if row is None:
            return None

        if bool(row.deleted):
            # Already in the recycle bin → permanent delete. Clear every
            # record owned by this workflow (tasks, messages, runs, reviews,
            # coordinator data) before removing the workflow row itself.
            self._delete_workflow_data(workflow_id)
            self._invalidate_workflow_schedules(workflow_id)
            self._prune_schedule_candidates(workflow_id)
            row.delete_instance()
            self._sync_project_workflows(proj)
            return {"deleted": True, "soft": False}

        if bool(row.is_default):
            return {"deleted": False, "reason": "default"}
        active_count = Workflow.select().where(Workflow.deleted == 0).count()
        if active_count <= 1:
            return {"deleted": False, "reason": "last"}

        row.deleted = 1
        row.updated_at = utc_now()
        row.save()
        self._invalidate_workflow_schedules(workflow_id)
        self._prune_schedule_candidates(workflow_id)
        self._sync_project_workflows(proj)
        return {"deleted": True, "soft": True}

    def _prune_schedule_candidates(self, workflow_id: str) -> None:
        """Drop a deleted workflow from agent-mode schedule candidates."""
        for schedule in Schedule.select().where(
            Schedule.status.in_(("active", "paused"))
        ):
            try:
                template = json.loads(schedule.task_template_json)
            except (json.JSONDecodeError, TypeError):
                continue
            if str(template.get("mode") or "static") != "agent":
                continue
            original = list(template.get("candidate_workflow_ids") or [])
            candidates = [wid for wid in original if wid != workflow_id]
            if candidates == original:
                continue
            template["candidate_workflow_ids"] = candidates
            schedule.task_template_json = json.dumps(template, ensure_ascii=False)
            schedule.updated_at = utc_now()
            if not candidates:
                schedule.status = "invalid"
                schedule.invalid_reason = (
                    f"Candidate workflow was deleted: {workflow_id}"
                )
                schedule.next_run_at = None
            schedule.save()

    def _invalidate_workflow_schedules(self, workflow_id: str) -> None:
        """Permanently stop schedules whose target workflow is unavailable."""
        Schedule.update(
            status="invalid",
            invalid_reason="Workflow was deleted",
            next_run_at=None,
            updated_at=utc_now(),
        ).where(Schedule.workflow_id == workflow_id).execute()

    def restore_workflow(self, proj: Project, workflow_id: str) -> dict | None:
        """Restore a soft-deleted (recycle bin) workflow. Returns the dict or None."""
        row = Workflow.get_or_none(Workflow.id == workflow_id)
        if row is None or not bool(row.deleted):
            return None
        row.deleted = 0
        row.updated_at = utc_now()
        row.save()
        self._sync_project_workflows(proj)
        return next((w for w in proj.workflows if w["id"] == workflow_id), None)

    def workflow_has_running_tasks(self, workflow_id: str) -> bool:
        """True when any task of the workflow is currently executing."""
        return Task.select().where(
            (Task.workflow_id == workflow_id) & (Task.status == "running")
        ).exists()

    def workflow_has_failed_tasks(self, workflow_id: str) -> bool:
        """True when an active task in the workflow has a failed step."""
        return (
            TaskStep.select()
            .join(Task)
            .where(
                Task.workflow_id == workflow_id,
                Task.archived == 0,
                TaskStep.status == "failed",
            )
            .exists()
        )

    def _delete_workflow_data(self, workflow_id: str) -> None:
        """Permanently delete every DB record owned by a workflow's tasks.

        Tasks reference their workflow via ``tasks.workflow_id``; all other
        tables cascade through ``tasks`` (messages, task steps, workflow/step
        runs, reviews, coordinator sessions/turns/proposals/supplements), so
        they are removed in FK dependency order before the tasks themselves.
        """
        task_ids = [
            t.id
            for t in Task.select(Task.id).where(Task.workflow_id == workflow_id)
        ]
        if not task_ids:
            return
        tasks = Task.id.in_(task_ids)
        run_ids = [
            r.id
            for r in WorkflowRun.select(WorkflowRun.id).where(
                WorkflowRun.task.in_(task_ids)
            )
        ]
        runs = WorkflowRun.id.in_(run_ids)

        StepSupplement.delete().where(StepSupplement.task.in_(task_ids)).execute()
        ActionProposal.delete().where(ActionProposal.task.in_(task_ids)).execute()
        CoordinatorTurn.delete().where(CoordinatorTurn.task.in_(task_ids)).execute()
        CoordinatorSession.delete().where(CoordinatorSession.task.in_(task_ids)).execute()
        ReviewRun.delete().where(ReviewRun.task.in_(task_ids)).execute()
        StepRun.delete().where(StepRun.run.in_(run_ids)).execute()
        WorkflowRun.delete().where(WorkflowRun.task.in_(task_ids)).execute()
        Message.delete().where(Message.task.in_(task_ids)).execute()
        TaskStep.delete().where(TaskStep.task.in_(task_ids)).execute()
        Task.delete().where(tasks).execute()
