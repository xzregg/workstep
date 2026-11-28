"""Manual start checkpoints. All functions run in the project DB executor."""
import json
from models import Task, TaskStep, WorkflowRun
from models.base import db_proxy
from models.fields import utc_now
from services.workflow_definition import WorkflowDefinition


def authorize_creation_entry(task_id, workflow, start_step_key):
    """Immediate/timed creation overrides only this task's selected entry."""
    from services.task_workflow import merge_workflow, canonical_workflow, build_overrides

    source = canonical_workflow(workflow)
    task = Task.get_by_id(task_id)
    edited = merge_workflow(source, json.loads(task.workflow_overrides_json or '{}'))
    entry = next((node for node in edited['nodes'] if node['type'] == start_step_key), None) if start_step_key else next(iter(edited['nodes']), None)
    if entry is None or entry['autoStart']:
        return
    entry['autoStart'] = True
    delta = build_overrides(source, edited)
    Task.update(workflow_overrides_json=json.dumps(delta, ensure_ascii=False)).where(Task.id == task_id).execute()


def gate_ready_steps(task_id, ready):
    """Persist waits only once their dependencies and artifact routes are ready."""
    waiting = set()
    with db_proxy.atomic():
        for step in ready:
            row = TaskStep.get((TaskStep.task == task_id) & (TaskStep.step_key == step.key))
            if step.auto_start or row.status in {'ready', 'reviewing'}:
                continue
            waiting.add(step.key)
            if row.status != 'awaiting_start':
                row.status, row.error, row.started_at, row.ended_at = 'awaiting_start', None, None, None
                row.save(only=[TaskStep.status, TaskStep.error, TaskStep.started_at, TaskStep.ended_at])
    return waiting


def authorize_manual_step(project, task_id, step_key, *, current_workflow_steps, instance_id, active_runner):
    """Grant one reached checkpoint in the current run; never restart upstream."""
    from services.workflow_recovery import lease_held_by_live_owner
    from services.project_audit import record_project_audit

    with db_proxy.atomic('IMMEDIATE'):
        task = Task.get_or_none(Task.id == task_id)
        if task is None:
            raise ValueError('Task not found')
        if task.status not in {'waiting', 'running'}:
            raise ValueError('Task is not waiting for a step to start')
        run = WorkflowRun.get_or_none((WorkflowRun.id == task.active_workflow_run_id) & (WorkflowRun.task == task))
        if run is None or run.status not in {'running', 'paused'}:
            raise ValueError('Execution round has changed or stopped')
        if lease_held_by_live_owner(run, utc_now(), instance_id):
            raise ValueError('Execution round is owned by another runtime')
        config = WorkflowDefinition.load(current_workflow_steps(project, task)).compile().to_steps_config()
        if not any(step['key'] == step_key for step in config['steps']):
            raise ValueError('Step does not exist')
        row = TaskStep.get_or_none((TaskStep.task == task) & (TaskStep.step_key == step_key))
        if row is None or row.status not in {'awaiting_start', 'ready', 'running'}:
            raise ValueError('Step is not waiting for manual start')
        if row.status == 'running' or (row.status == 'ready' and active_runner):
            return task, run, config, False
        row.status = 'ready'
        row.save(only=[TaskStep.status])
        if not active_runner:
            run.status, run.ended_at = 'running', None
            run.owner_id, run.heartbeat_at = instance_id, utc_now()
            run.save(only=[WorkflowRun.status, WorkflowRun.ended_at, WorkflowRun.owner_id, WorkflowRun.heartbeat_at])
        task.status, task.status_reason, task.updated_at = 'running', 'execution', utc_now()
        task.state_version += 1
        task.save(only=[Task.status, Task.status_reason, Task.updated_at, Task.state_version])
        record_project_audit(project_id=project.id, task_id=task.id,
                             action='task.start', result='succeeded', metadata={'step_key': step_key})
        return task, run, config, True


def stop_manual_wait(project, task_id, *, instance_id, action):
    from services.workflow_recovery import lease_held_by_live_owner
    from services.workflow_finalization import settle_interrupted_run
    from services.project_audit import record_project_audit

    with db_proxy.atomic('IMMEDIATE'):
        task = Task.get_or_none(Task.id == task_id)
        if task is None or task.status != 'waiting' or not TaskStep.select().where(
            (TaskStep.task == task) & TaskStep.status.in_(['awaiting_start', 'ready'])
        ).exists():
            return False
        run = WorkflowRun.get_or_none((WorkflowRun.id == task.active_workflow_run_id) & (WorkflowRun.task == task))
        if run is None or lease_held_by_live_owner(run, utc_now(), instance_id):
            return False
        settle_interrupted_run(task.id, run.id, 'Stopped manually', stopped=True)
        record_project_audit(project_id=project.id, task_id=task.id, action=action,
                             result='succeeded', metadata={'status': 'stopped'})
        return True
