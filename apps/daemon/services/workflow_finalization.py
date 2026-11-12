"""Failure/stop persistence for a workflow whose execution has drained."""

from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from models.base import db_proxy
from models.fields import utc_now


def settle_interrupted_run(task_id, run_id, error, *, stopped=False):
    """Run in the project DB executor, after all child coroutines have exited."""
    with db_proxy.atomic('IMMEDIATE'):
        task = Task.get_or_none(Task.id == task_id)
        if task is None or (run_id and task.active_workflow_run_id != run_id):
            return
        run = WorkflowRun.get_or_none(WorkflowRun.id == run_id) if run_id else None
        if run is not None and run.status == 'superseded':
            return
        stopped = stopped or task.status == 'stopped'
        now = utc_now()
        task.status = 'stopped' if stopped else 'failed'
        task.status_reason = 'user_stop' if stopped else 'engine_error'
        task.queued_run_json = None
        task.updated_at = now
        task.state_version += 1
        task.save()
        active = ['running', 'reviewing', 'retrying', 'rework', 'rework_waiting']
        if stopped:
            active.append('awaiting_review')
        TaskStep.update(
            status='cancelled' if stopped else 'failed', error=error,
            ended_at=now, waiting_interactions_json=None,
        ).where((TaskStep.task == task) & TaskStep.status.in_(active)).execute()
        if run is None:
            return
        run.status = 'stopped' if stopped else 'failed'
        run.ended_at = now
        run.owner_id = run.heartbeat_at = None
        run.save()
        StepRun.update(status='failed', error=error, ended_at=now).where(
            (StepRun.run == run) & (StepRun.status == 'running')
        ).execute()
        ReviewRun.update(status='cancelled' if stopped else 'failed', error=error, ended_at=now).where(
            (ReviewRun.workflow_run == run)
            & ReviewRun.status.in_(['running', 'pending'] if stopped else ['running'])
        ).execute()
        Message.update(run_status='cancelled' if stopped else 'failed', ended_at=now).where(
            (Message.task == task) & (Message.run_status == 'running')
            & Message.step_run_id.in_(StepRun.select(StepRun.id).where(StepRun.run == run))
        ).execute()
