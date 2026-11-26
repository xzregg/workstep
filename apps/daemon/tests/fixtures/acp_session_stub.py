"""Real JSON-RPC ACP transport peer for offline reuse tests."""
import json
import os
from pathlib import Path
import sys
import uuid

root = Path(sys.argv[1])
pending = {}
waiting = {}


def send(value):
    print(json.dumps({'jsonrpc': '2.0', **value}), flush=True)


def result(message, value):
    send({'id': message['id'], 'result': value})


def answer(request, sid, text):
    send({'method': 'session/update', 'params': {'sessionId': sid, 'update': {
        'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': text}}}})
    result(request, {'stopReason': 'end_turn'})


for line in sys.stdin:
    message = json.loads(line)
    with (root / 'wire.jsonl').open('a') as log:
        log.write(json.dumps({'pid': os.getpid(), **message}) + '\n')
    method = message.get('method')
    params = message.get('params') or {}
    if method is None:
        saved = pending.pop(str(message.get('id')), None)
        if saved:
            kind, request, sid, tool_call_id = saved
            if kind == 'permission':
                accepted = message.get('result', {}).get('outcome', {}).get('optionId') == 'allow'
                answer(request, sid, 'accepted' if accepted else 'denied')
            elif kind == 'elicitation':
                if 'error' in message:
                    send({'method': 'session/update', 'params': {'sessionId': sid, 'update': {
                        'sessionUpdate': 'tool_call_update', 'toolCallId': tool_call_id,
                        'status': 'completed', 'rawOutput': 'fallback'}}})
                    answer(request, sid, f"fallback-in-chat:{message['error'].get('code')}")
                else:
                    res = message.get('result') or {}
                    send({'method': 'session/update', 'params': {'sessionId': sid, 'update': {
                        'sessionUpdate': 'tool_call_update', 'toolCallId': tool_call_id,
                        'status': 'completed', 'rawOutput': json.dumps(res, sort_keys=True)}}})
                    send({'method': 'elicitation/complete', 'params': {'elicitationId': tool_call_id}})
                    answer(request, sid, json.dumps(res, sort_keys=True))
    elif method == 'initialize':
        result(message, {'protocolVersion': 1, 'agentCapabilities': {
            'loadSession': True, 'sessionCapabilities': {'resume': {}},
            'promptCapabilities': {'image': True}},
            'agentInfo': {'name': 'offline-peer', 'version': '1.0'}})
    elif method == 'session/new':
        result(message, {'sessionId': str(uuid.uuid4())})
    elif method == 'session/set_config_option' and (root / 'reject-mode').exists():
        send({'id':message['id'],'error':{'code':-32602,'message':'mode unavailable'}})
    elif method in {'session/load', 'session/resume', 'session/set_config_option'}:
        if method != 'session/set_config_option' and (root / 'replay-history').exists():
            for update in [
                {'sessionUpdate':'user_message_chunk','content':{'type':'text','text':'old user'}},
                {'sessionUpdate':'agent_thought_chunk','content':{'type':'text','text':'old thought'}},
                {'sessionUpdate':'tool_call','toolCallId':'old-tool','title':'old command','kind':'execute','status':'completed'},
                {'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'hello'}},
                {'sessionUpdate':'config_option_update','configOptions':[]},
            ]:
                send({'method':'session/update','params':{'sessionId':params['sessionId'],'update':update}})
        result(message, {'configOptions': []})
    elif method == 'session/prompt':
        sid = params['sessionId']
        prompt = '\n'.join(p.get('text', '') for p in params['prompt'])
        if prompt == 'crash':
            os._exit(7)
        elif prompt == 'wait':
            waiting[sid] = message
        elif prompt == 'approve':
            key = str(uuid.uuid4())
            pending[key] = ('permission', message, sid, key)
            send({'id': key, 'method': 'session/request_permission', 'params': {
                'sessionId': sid, 'toolCall': {'toolCallId': key, 'title': 'Synthetic command', 'kind': 'execute'},
                'options': [{'optionId': 'allow', 'name': 'Allow', 'kind': 'allow_once'},
                            {'optionId': 'deny', 'name': 'Deny', 'kind': 'reject_once'}]}})
        elif prompt == 'ask_question':
            key = str(uuid.uuid4())
            tool_call_id = f'ask-{key}'
            pending[key] = ('elicitation', message, sid, tool_call_id)
            send({'method': 'session/update', 'params': {'sessionId': sid, 'update': {
                'sessionUpdate': 'tool_call', 'toolCallId': tool_call_id,
                'title': 'Run ask_question', 'kind': 'other', 'status': 'in_progress',
                'rawInput': {'questions': [
                    {'question': '部署形态', 'options': ['独立极简服务', '集成到 Gateway'], 'is_multi_select': False},
                    {'question': '能力选择', 'options': ['STUN', 'TURN'], 'is_multi_select': True},
                ]},
            }}})
            send({'id': key, 'method': 'elicitation/create', 'params': {
                'sessionId': sid,
                'toolCallId': tool_call_id,
                'mode': 'form',
                'message': '请选择部署形态',
                'requestedSchema': {
                    'type': 'object',
                    'properties': {
                        'q1': {
                            'type': 'string',
                            'title': '部署形态',
                            'oneOf': [
                                {'const': 'standalone', 'title': '独立极简服务'},
                                {'const': 'gateway', 'title': '集成到 Gateway'},
                            ],
                        },
                        'q2': {
                            'type': 'array',
                            'title': '能力选择',
                            'items': {
                                'anyOf': [
                                    {'const': 'stun', 'title': 'STUN'},
                                    {'const': 'turn', 'title': 'TURN'},
                                ],
                            },
                        },
                    },
                    'required': ['q1'],
                },
            }})
        else:
            answer(message, sid, 'x' * 100_000 if prompt == 'large' else prompt)
    elif method == 'session/cancel':
        if 'id' in message:
            result(message, {})
        request = waiting.pop(params['sessionId'], None)
        if request:
            result(request, {'stopReason': 'cancelled'})
    elif 'id' in message:
        result(message, {})
