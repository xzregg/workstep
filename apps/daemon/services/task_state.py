"""Canonical task state aggregation; database helpers run in project work units."""
import json


def _value(row, key, default=None):
    return row.get(key, default) if isinstance(row, dict) else getattr(row, key, default)


def waiting_interactions(step) -> dict[str, str]:
    try:
        value = json.loads(_value(step, 'waiting_interactions_json') or '{}')
    except (ValueError, TypeError):
        return {}
    return {key: reason for key, reason in value.items()
            if reason in {'tool_approval', 'user_input'}} if isinstance(value, dict) else {}


def summarize_task_state(status, steps, *, reason=None, settled=False):
    """Aggregate current workflow steps, retaining waits during parallel work.

    ``settled`` means the scheduler has exhausted runnable work. Pending steps
    between two engine calls must not be misclassified as a blocked workflow.
    """
    steps = [step for step in steps if _value(step, 'in_workflow', True)]
    pending = []
    active = []
    for step in steps:
        key, state = _value(step, 'step_key'), _value(step, 'status')
        if state == 'awaiting_review':
            pending.append({'step_key': key, 'reason': 'manual_review'})
        elif state in {'running', 'reviewing'}:
            interactions = waiting_interactions(step)
            pending.extend({'step_key': key, 'reason': value, 'interaction_id': identity}
                           for identity, value in interactions.items())
            if not interactions:
                active.append(state)
        elif state in {'retrying', 'rework'}:
            active.append(state)

    if status in {'ready', 'queued', 'completed'}:
        reason = 'concurrency_limit' if status == 'queued' else None
        pending = []
    elif status == 'stopped' and reason == 'user_stop':
        pending = []
    elif status == 'stopped' and reason is None and not any(
        _value(step, 'status') in {'failed', 'rejected'} for step in steps
    ):
        reason, pending = 'user_stop', []
    elif status == 'failed' and reason in {'engine_error', 'workflow_blocked'}:
        pass
    elif active:
        status = 'running'
        reason = ('execution' if 'running' in active else
                  'auto_review' if 'reviewing' in active else 'rework')
    elif any(_value(step, 'status') in {'failed', 'rejected'} for step in steps):
        status, reason = 'failed', reason if reason in {'engine_error', 'workflow_blocked'} else 'step_failed'
    elif status == 'waiting' and reason == 'manual_continue':
        pass
    elif pending:
        status, reason = 'waiting', pending[0]['reason']
    elif any(_value(step, 'status') == 'cancelled' for step in steps) or reason == 'user_stop':
        status, reason = 'stopped', 'user_stop'
    elif settled and steps and all(_value(step, 'status') in {'passed', 'skipped'} for step in steps):
        status, reason = 'completed', None
    elif settled or status in {'paused', 'failed', 'waiting'}:
        status, reason = 'failed', reason or 'workflow_blocked'
    else:
        reason = 'execution' if status == 'running' else reason
    return {'status': status, 'status_reason': reason, 'pending_confirmations': pending}


def current_task_steps(task):
    """Ignore historical steps removed from the workflow (no filesystem I/O)."""
    from models import TaskStep, Workflow, WorkflowRun
    rows = list(TaskStep.select().where(TaskStep.task == task))
    source = Workflow.get_or_none((Workflow.id == task.workflow_id) & (Workflow.deleted == 0)) if task.workflow_id else None
    if source is not None:
        definition = json.loads(source.steps_json)
        nodes = definition.get('nodes', definition.get('steps', []))
        keys = {str(node.get('type') or node.get('key') or node.get('id')) for node in nodes}
        overlay = json.loads(task.workflow_overrides_json or '{}')
        keys.update(node['type'] for node in overlay.get('added_nodes', []))
        keys.difference_update(str(key) for key in overlay.get('removed_nodes', []))
        rows = [row for row in rows if row.step_key in keys]
    run = WorkflowRun.get_or_none((WorkflowRun.id == task.active_workflow_run_id) & (WorkflowRun.task == task)) if task.active_workflow_run_id else None
    scope = json.loads(run.routing_state_json or '{}').get('execution_scope') if run is not None else None
    return [row for row in rows if row.step_key in scope] if isinstance(scope, list) else rows


def reconcile_task_state(task, *, settled=False, reason=None):
    """Persist a task aggregate; caller must already be in its DB executor."""
    from models.fields import utc_now
    state = summarize_task_state(task.status, current_task_steps(task),
                                 reason=reason or task.status_reason, settled=settled)
    if (task.status, task.status_reason) != (state['status'], state['status_reason']):
        task.status, task.status_reason = state['status'], state['status_reason']
        task.updated_at = utc_now()
        task.state_version += 1
        task.save(only=[type(task).status, type(task).status_reason,
                        type(task).updated_at, type(task).state_version])
    return state


def task_has_active_execution(task):
    """A runner waiting for tool approval is still active for destructive actions."""
    return task.status == 'running' or (task.status == 'waiting' and any(
        row.status in {'running', 'reviewing'} for row in current_task_steps(task)
    ))
