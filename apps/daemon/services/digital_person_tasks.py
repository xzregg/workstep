"""Stable delegation tasks and immutable identities for their execution rounds.

Helpers operate on materialized state only; persistence stays in the runtime.
"""


def normalize_tasks(state):
    """Fold legacy per-turn delegations into one task per project/chat, without deletion."""
    groups = {}
    history = state.setdefault('delegation_executions', [])
    for row in state.get('delegations', []):
        key = (row.get('project_id'), row.get('session_id') or row['id'])
        groups.setdefault(key, []).append(row)
    tasks = []
    known = {row.get('execution_id', row['id']) for row in history}
    for rows in groups.values():
        rows.sort(key=lambda row: str(row.get('created_at', '')))
        task_id = rows[0]['id']
        origin = rows[0].get('origin_session_id')
        for row in rows:
            row.setdefault('execution_id', row['id'])
            row['id'] = task_id
            if origin is not None:
                row.setdefault('request_origin_session_id', row.get('origin_session_id'))
                row['origin_session_id'] = origin
        for row in rows[:-1]:
            if row['execution_id'] not in known:
                history.append(row.copy())
                known.add(row['execution_id'])
        tasks.append(rows[-1])
    state['delegations'] = tasks
    return state


def all_executions(state):
    return [*state.get('delegation_executions', []), *state.get('delegations', [])]


def resolve_task(state, identifier):
    execution = next((row for row in all_executions(state)
                      if identifier in (row['id'], row.get('execution_id'))), None)
    if execution is None:
        return None
    return next((row for row in state['delegations'] if row['id'] == execution['id']), None)


def find_execution(state, item):
    return next((row for row in all_executions(state)
                 if row['id'] == item['id'] and row.get('message_id') == item.get('message_id')), None)
