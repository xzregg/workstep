"""Synchronous database work units for authenticated task-share boundaries."""

import json
import re
from pathlib import Path

from models import ActionProposal, ActionRun, Message, PendingMessageInsert, ReviewRun, Schedule, Task


class SharedTaskScopeError(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def validate_operation(_project, task_id, path, method, query, body):
    task = Task.get_or_none(Task.id == task_id)
    if task is None:
        raise SharedTaskScopeError(404, "Task unavailable")

    if path.startswith('/schedule/'):
        if path in {'/schedule/list', '/schedule/notification-options'}:
            if query.get('task_id') not in (None, task_id) or query.get('target_type') not in (None, 'task'):
                raise SharedTaskScopeError(403, "Task schedule scope denied")
        elif path == '/schedule/create':
            if body.get('target_type') != 'task' or body.get('target_task_id') != task_id:
                raise SharedTaskScopeError(403, "Task schedule scope denied")
        elif path != '/schedule/preview':
            match = re.fullmatch(r'/schedule/([A-Za-z0-9_-]+)(?:/(?:pause|resume|runs|runs/[A-Za-z0-9_-]+/notification/retry))?', path)
            if match:
                row = Schedule.get_or_none((Schedule.id == match[1]) & (Schedule.target_type == 'task') & (Schedule.target_task_id == task_id))
                if row is None:
                    raise SharedTaskScopeError(404, "Task schedule unavailable")
                if body.get('target_type', 'task') != 'task' or body.get('target_task_id', task_id) != task_id:
                    raise SharedTaskScopeError(403, "Task schedule scope denied")

    def message(identifier):
        if not Message.select().where((Message.id == identifier) & (Message.task == task_id)).exists():
            raise SharedTaskScopeError(404, "Task message unavailable")

    def insert(identifier):
        row = PendingMessageInsert.get_or_none(PendingMessageInsert.id == identifier)
        if row is None:
            raise SharedTaskScopeError(404, "Pending insert unavailable")
        message(row.target_message_id)

    task_path = '/task/' + task_id
    if path == '/pending-message-inserts' or path.startswith('/pending-message-inserts/'):
        targets = [container.get('target_message_id') for container in (query, body) if container.get('target_message_id')]
        if targets:
            for target in targets:
                message(target)
        elif method in {'GET', 'POST', 'PUT'} or path == '/pending-message-inserts':
            raise SharedTaskScopeError(422, "Target message required")
        if path.startswith('/pending-message-inserts/') and not path.endswith('/reorder'):
            insert(path.rsplit('/', 1)[-1])
        for identifier in body.get('ids', []):
            insert(identifier)
    if path.startswith(task_path + '/messages/'):
        message(path[len(task_path + '/messages/'):].split('/')[0])
    if path.startswith(task_path + '/actions/'):
        validate_proposal(_project, task_id, path[len(task_path + '/actions/'):].split('/')[0])
    for identifier in body.get('pending_insert_ids', []):
        insert(identifier)
    if body.get('review_run_id'):
        if not ReviewRun.select().where((ReviewRun.id == body['review_run_id']) & (ReviewRun.task == task_id)).exists():
            raise SharedTaskScopeError(404, "Review unavailable")
    if path.startswith('/action-runs/'):
        identifier = path.split('/')[2]
        if not ActionRun.select().where((ActionRun.id == identifier) & (ActionRun.task_id == task_id)).exists():
            raise SharedTaskScopeError(404, "Action run unavailable")
    if body.get('task_id') not in (None, task_id):
        raise SharedTaskScopeError(403, "Task scope denied")
    return task.workflow_id


def validate_proposal(_project, task_id, proposal_id):
    proposal = ActionProposal.get_or_none(
        (ActionProposal.id == proposal_id) & (ActionProposal.task == task_id)
    )
    if proposal is None:
        raise SharedTaskScopeError(404, "Action proposal unavailable")


def is_edited_task_file(project, task_id, resolved):
    paths = []
    for row in Message.select(Message.event_summary_json).where(Message.task == task_id):
        try:
            summary = json.loads(row.event_summary_json or '{}')
        except ValueError:
            continue
        paths.extend(summary.get('edited_files') or [])
    return any((Path(p) if Path(p).is_absolute() else project.path / p).resolve() == resolved for p in paths)
