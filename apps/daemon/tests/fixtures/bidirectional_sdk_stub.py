"""Offline Claude/Qoder stream-json peer. No credentials or network."""
import json
import os
from pathlib import Path
import sys
import uuid

if '--version' in sys.argv or '-v' in sys.argv:
    print('99.0.0')
    raise SystemExit
sid = next((arg.split('=', 1)[1] for arg in sys.argv if arg.startswith('--resume=')), None)
sid = sid or (sys.argv[sys.argv.index('--resume') + 1] if '--resume' in sys.argv else str(uuid.uuid4()))
root = Path(os.environ['WORKSTEP_TEST_PEER_ROOT'])
pending = {}
turns = 0


def send(value):
    print(json.dumps(value), flush=True)


def answer(text, *, failed=False):
    send({'type': 'assistant', 'session_id': sid, 'message': {
        'role': 'assistant', 'model': 'synthetic', 'content': [{'type': 'text', 'text': text}]}})
    send({'type': 'result', 'subtype': 'error_during_execution' if failed else 'success',
          'duration_ms': 1, 'duration_api_ms': 1, 'is_error': failed,
          'num_turns': turns, 'session_id': sid, 'result': text})


for line in sys.stdin:
    msg = json.loads(line)
    with (root / 'wire.jsonl').open('a') as log:
        log.write(json.dumps({'pid': os.getpid(), 'sid': sid, 'message': msg}) + '\n')
    if msg['type'] == 'control_request':
        send({'type': 'control_response', 'response': {
            'subtype': 'success', 'request_id': msg['request_id'], 'response': {}}})
    elif msg['type'] == 'control_response':
        if msg['response']['request_id'] in pending:
            decision = msg['response'].get('response', {}).get('behavior')
            answer('accepted' if decision == 'allow' else 'denied')
    elif msg['type'] == 'user':
        turns += 1
        if turns == 1:
            send({'type': 'system', 'subtype': 'init', 'session_id': sid})
        text = msg['message']['content']
        if not isinstance(text, str):
            text = '\n'.join(item.get('text', '') for item in text)
        if text == 'crash':
            os._exit(7)
        elif text == 'wait':
            continue
        elif text == 'approve':
            key = str(uuid.uuid4())
            pending[key] = True
            send({'type': 'control_request', 'request_id': key, 'request': {
                'subtype': 'can_use_tool', 'tool_name': 'Bash',
                'input': {'command': 'synthetic'}, 'tool_use_id': key}})
        else:
            answer('x' * 100_000 if text == 'large' else text, failed=text == 'fail')
