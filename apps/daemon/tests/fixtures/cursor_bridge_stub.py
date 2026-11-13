"""Offline Connect RPC bridge peer for the real Cursor Python SDK."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import struct
import sys
import threading
import uuid

root = Path(sys.argv[1])
cancelled = {}


def frame(value, flag=0):
    value = json.dumps(value).encode()
    return bytes([flag]) + struct.pack('>I', len(value)) + value


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        streaming = self.headers.get('Content-Type', '').startswith('application/connect+')
        request = json.loads(body[5:] if streaming else body)
        method = self.path.rsplit('/', 1)[-1]
        with (root / 'wire.jsonl').open('a') as log:
            log.write(json.dumps({'pid': os.getpid(), 'method': method, 'request': request}) + '\n')
        if method == 'Send':
            prompt = request['message'].get('text', request['message'].get('content', []))
            text = prompt if isinstance(prompt, str) else ''.join(p.get('text', '') for p in prompt)
            if text == 'crash':
                os._exit(7)
            agent = request['agentId']
            run = str(uuid.uuid4())
            cancelled[run] = threading.Event()
            self.send_response(200)
            self.send_header('Content-Type', 'application/connect+json')
            self.send_header('Connection', 'close')
            self.end_headers()
            try:
                self.wfile.write(frame({'sdkMessage': {'type': 'system', 'agentId': agent,
                                                     'runId': run, 'subtype': 'init'}}))
                self.wfile.flush()
                if text == 'wait':
                    cancelled[run].wait(15)
                answer = 'x' * 100_000 if text == 'large' else text
                self.wfile.write(frame({'sdkMessage': {'type': 'assistant', 'agentId': agent,
                    'runId': run, 'message': {'content': [{'type': 'text', 'text': answer}]}}}))
                self.wfile.write(frame({'result': {'result': {'runId': run, 'agentId': agent,
                    'status': 'cancelled' if cancelled[run].is_set() else 'finished', 'result': answer}}}))
                self.wfile.write(frame({}, 2))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        value = {}
        if method == 'CreateAgent':
            value = {'agentId': str(uuid.uuid4())}
        elif method == 'ResumeAgent':
            value = {'agentId': request['agentId']}
        elif method == 'CancelRun':
            if event := cancelled.get(request.get('runId')):
                event.set()
        elif method == 'Shutdown':
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        payload = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
server.daemon_threads = True
print('cursor-sdk-bridge ready ' + json.dumps({
    'schemaVersion': 1, 'transport': 'tcp', 'protocol': 'connect',
    'url': f'http://127.0.0.1:{server.server_port}', 'authToken': 'offline-test-token',
    'pid': os.getpid(), 'serverVersion': 'test',
}), file=sys.stderr, flush=True)
server.serve_forever()
