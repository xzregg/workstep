"""Deterministic stdio peer for real openai-codex SDK lifecycle tests.

No model, credentials or network. All state is synthetic and test-owned.
"""
import json
import os
from pathlib import Path
import sys
import uuid

store = Path(sys.argv[1])
store.mkdir(exist_ok=True)
pending = {}
waiting = {}
state = {}


def save_state():
    for tid, value in state.items():
        (store / f'thread-{tid}.json').write_text(json.dumps(value))


def goal_update(tid, status):
    goal = state[tid]['goal']
    goal['status'] = status
    save_state()
    notify('thread/goal/updated', {'threadId': tid, 'goal': goal})


def finish_goal(tid, turn_id):
    goal = state[tid]['goal']
    complete(tid, turn_id, 'goal-first')
    next_id = str(uuid.uuid4())
    notify('turn/started', {'threadId': tid, 'turn': turn(next_id)})
    status = {
        'goal-pause': 'paused', 'goal-blocked': 'blocked',
        'goal-budget': 'budgetLimited', 'goal-usage': 'usageLimited',
        'goal-turn-fail': 'blocked',
    }.get(goal['objective'], 'complete')
    goal_update(tid, status)
    complete(tid, next_id, 'goal-second',
             'failed' if goal['objective'] == 'goal-turn-fail' else 'completed')


def send(value):
    print(json.dumps(value), flush=True)


def result(request, value):
    send({'id': request['id'], 'result': value})


def notify(method, params):
    send({'method': method, 'params': params})


def thread(tid):
    return {'id': tid, 'cliVersion': '0.167.0', 'createdAt': 1, 'updatedAt': 1,
            'cwd': str(store), 'ephemeral': False, 'modelProvider': 'openai', 'preview': '',
            'sessionId': tid, 'source': 'appServer', 'status': {'type': 'idle'}, 'turns': []}


def thread_result(tid):
    return {'thread': thread(tid), 'model': 'synthetic', 'modelProvider': 'openai',
            'cwd': str(store), 'approvalPolicy': 'never', 'approvalsReviewer': 'user',
            'sandbox': {'type': 'readOnly'}}


def turn(tid, status='inProgress', error=None):
    return {'id': tid, 'items': [], 'status': status, 'error': error}


def complete(thread_id, turn_id, text='ok', status='completed'):
    if text:
        item = {'id': 'answer-' + turn_id, 'type': 'agentMessage', 'phase': 'final_answer', 'text': ''}
        notify('item/started', {'threadId': thread_id, 'turnId': turn_id, 'item': item, 'startedAtMs': 1})
        notify('item/agentMessage/delta', {'threadId': thread_id, 'turnId': turn_id,
                                         'itemId': item['id'], 'delta': text})
        notify('item/completed', {'threadId': thread_id, 'turnId': turn_id,
                                  'item': {**item, 'text': text}, 'completedAtMs': 2})
    error = {'message': 'synthetic failure'} if status == 'failed' else None
    notify('turn/completed', {'threadId': thread_id, 'turn': turn(turn_id, status, error)})


for raw in sys.stdin:
    message = json.loads(raw)
    if 'method' not in message:
        saved = pending.pop(str(message.get('id')), None)
        if saved:
            tid, turn_id, kind = saved
            reply = message.get('result') or {}
            accepted = reply.get('decision') == 'accept'
            complete(tid, turn_id, 'accepted' if accepted else 'denied')
            if kind == 'goal':
                goal_update(tid, 'complete' if accepted else 'blocked')
        continue
    method, params = message['method'], message.get('params') or {}
    with (store / 'wire.jsonl').open('a') as log:
        log.write(json.dumps({'method': method, 'params': params, 'pid': os.getpid()}) + '\n')
    if method == 'initialize':
        result(message, {'userAgent': 'codex/0.167.0', 'serverInfo': {'name': 'codex', 'version': '0.167.0'}})
    elif method == 'initialized':
        continue
    elif method in ('thread/start', 'thread/resume', 'thread/fork'):
        tid = params.get('threadId') if method == 'thread/resume' else str(uuid.uuid4())
        state_path = store / f'thread-{tid}.json'
        state.setdefault(tid, json.loads(state_path.read_text()) if state_path.exists()
                         else {'mode': 'default', 'goal': None})
        save_state()
        result(message, thread_result(tid))
    elif method == 'turn/start':
        tid, turn_id = params['threadId'], str(uuid.uuid4())
        prompt = '\n'.join(item.get('text', '') for item in params['input'])
        if 'collaborationMode' in params:
            state[tid]['mode'] = params['collaborationMode']['mode']
            save_state()
        result(message, {'turn': turn(turn_id)})
        notify('turn/started', {'threadId': tid, 'turn': turn(turn_id)})
        if prompt == 'crash':
            os._exit(7)
        elif prompt in ('approve', 'approve-wait'):
            key = 'approval-' + turn_id
            pending[key] = tid, turn_id, 'approval'
            send({'id': key, 'method': 'item/commandExecution/requestApproval',
                  'params': {'threadId': tid, 'turnId': turn_id, 'itemId': 'tool-' + turn_id,
                             'command': 'synthetic command'}})
        elif prompt == 'wait' or prompt.startswith('goal-'):
            waiting[tid] = turn_id
        elif prompt == 'fail':
            complete(tid, turn_id, '', 'failed')
        elif prompt == 'large':
            complete(tid, turn_id, 'x' * 100_000)
        elif prompt == 'effective-mode':
            complete(tid, turn_id, state[tid]['mode'])
        else:
            complete(tid, turn_id, prompt or 'image')
    elif method == 'turn/steer':
        result(message, {'turnId': params['expectedTurnId']})
        complete(params['threadId'], params['expectedTurnId'], 'steered')
    elif method == 'turn/interrupt':
        result(message, {})
        complete(params['threadId'], params['turnId'], '', 'interrupted')
    elif method == 'thread/compact/start':
        result(message, {})
        notify('thread/compacted', {'threadId': params['threadId'], 'turnId': str(uuid.uuid4())})
    elif method == 'thread/inject_items':
        result(message, {})
    elif method == 'thread/read':
        tid = params['threadId']
        value = thread(tid)
        if tid in waiting:
            value['turns'] = [turn(waiting[tid])]
        result(message, {'thread': value})
    elif method == 'thread/unsubscribe':
        tid = params['threadId']
        waiting.pop(tid, None)
        for key, value in list(pending.items()):
            if value[0] == tid:
                pending.pop(key)
        result(message, {'status': 'unsubscribed'})
    elif method == 'thread/goal/get':
        result(message, {'goal': state[params['threadId']]['goal']})
    elif method == 'thread/goal/clear':
        tid = params['threadId']
        cleared = state[tid]['goal'] is not None
        state[tid]['goal'] = None
        save_state()
        result(message, {'cleared': cleared})
        # Clearing a nonexistent goal is silent, like the native server.
    elif method == 'thread/goal/set':
        tid = params['threadId']
        objective = params.get('objective')
        if objective == 'goal-set-fail':
            send({'id': message['id'], 'error': {'code': -32603, 'message': 'synthetic goal set failure'}})
            continue
        goal = state[tid]['goal'] or {
            'threadId': tid, 'objective': objective or 'goal-resumed', 'status': 'active',
            'createdAt': 1, 'updatedAt': 1, 'timeUsedSeconds': 0, 'tokensUsed': 0,
        }
        goal['status'] = params.get('status', goal['status'])
        state[tid]['goal'] = goal
        save_state()
        result(message, {'goal': goal})
        goal_update(tid, goal['status'])
        if goal['status'] == 'active':
            turn_id = waiting.pop(tid, None)
            if turn_id is None:
                turn_id = str(uuid.uuid4())
                notify('turn/started', {'threadId': tid, 'turn': turn(turn_id)})
            if objective == 'goal-crash':
                os._exit(7)
            elif objective == 'goal-wait':
                waiting[tid] = turn_id
            elif objective == 'goal-approve':
                key = 'approval-' + turn_id
                pending[key] = tid, turn_id, 'goal'
                send({'id': key, 'method': 'item/commandExecution/requestApproval',
                      'params': {'threadId': tid, 'turnId': turn_id, 'itemId': 'tool-' + turn_id,
                                 'command': 'synthetic goal command'}})
            else:
                finish_goal(tid, turn_id)
    else:
        result(message, {})
