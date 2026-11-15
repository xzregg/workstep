import asyncio
import base64
import json
import time

import httpx
import pytest
from fastapi import FastAPI

from api import speech_output
from services.speech_output import SpeechOutputService


@pytest.fixture
def output(tmp_path, monkeypatch):
    service = SpeechOutputService(tmp_path)
    monkeypatch.setattr(speech_output, 'service', service)
    monkeypatch.setattr(speech_output, 'require_catalog_project', lambda project: None)
    monkeypatch.setattr(speech_output, 'get_current_actor', lambda: None)
    return service


def app():
    result = FastAPI()
    result.include_router(speech_output.router)

    @result.get('/health')
    async def health():
        return {'ok': True}
    return result


@pytest.mark.asyncio
async def test_settings_encrypt_credentials_and_preserve_only_same_destination(output):
    settings = dict(mode='cloud', provider='qwen', api_key='private-key', model='qwen3-tts-flash-realtime', voice='Cherry')
    await output.configure(settings)
    status = await output.snapshot()
    assert status['settings']['has_api_key']
    assert 'private-key' not in json.dumps(status)
    assert 'private-key' not in (output.root / 'settings.json').read_text()
    await output.configure({**settings, 'api_key': None})
    assert (await output.settings())['api_key'] == 'private-key'
    await output.configure({**settings, 'provider': 'openai', 'api_key': None})
    assert not (await output.settings())['api_key']
    reloaded = SpeechOutputService(output.root)
    assert (await reloaded.settings())['provider'] == 'openai'
    await output.close()


@pytest.mark.asyncio
async def test_synthesis_is_scoped_streamed_cancellable_and_health_remains_responsive(output, monkeypatch):
    await output.configure(dict(mode='remote', provider='openai', base_url='http://localhost:9988/v1', model='kokoro', voice='zf_xiaoni'))
    released = asyncio.Event()

    async def slow(settings, text):
        try:
            await asyncio.to_thread(time.sleep, .15)
            yield {'audio': base64.b64encode(b'\0\0' * 100).decode(), 'format': 'pcm', 'sample_rate': 24000}
            await asyncio.sleep(60)
        finally:
            released.set()
    monkeypatch.setattr(output, '_audio', slow)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        result = await client.post('/api/speech-output/sessions?project_id=p', json={'text': '你好'})
        assert result.status_code == 200
        sid = result.json()['id']
        assert (await client.post(f'/api/speech-output/sessions/{sid}/next?project_id=other')).status_code == 404
        job = asyncio.create_task(client.post(f'/api/speech-output/sessions/{sid}/next?project_id=p'))
        await asyncio.sleep(.02)
        assert (await asyncio.wait_for(client.get('/health'), .08)).json() == {'ok': True}
        chunk = (await job).json()
        assert chunk['audio'] and not chunk['done']
        assert (await client.delete(f'/api/speech-output/sessions/{sid}?project_id=p')).status_code == 200
        assert released.is_set()
        assert not output.sessions
    await output.close()


@pytest.mark.asyncio
async def test_draft_test_does_not_save_settings_and_failures_are_redacted(output, monkeypatch):
    async def broken(settings, text):
        raise RuntimeError('credential=private-key https://example.com?token=secret')
        yield
    monkeypatch.setattr(output, '_audio', broken)
    sid = (await output.start('p', 'alice', 'test', dict(mode='cloud', provider='qwen', api_key='private-key')))['id']
    result = await output.next(sid, 'p', 'alice')
    assert result['done'] and result['error']
    assert 'private-key' not in json.dumps(result) and 'secret' not in json.dumps(result)
    assert (await output.settings())['mode'] == 'system'
    with pytest.raises(LookupError):
        await output.next(sid, 'p', 'bob')
    await output.cancel(sid, 'p', 'alice')
    await output.close()


@pytest.mark.asyncio
async def test_host_settings_reject_project_identity(output, monkeypatch):
    from fastapi import HTTPException
    def require(project):
        if not project:
            raise HTTPException(403, 'host scope required')
    monkeypatch.setattr(speech_output, 'require_catalog_project', require)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        assert (await client.get('/api/speech-output')).status_code == 403
        assert (await client.put('/api/speech-output/settings', json={'mode': 'system'})).status_code == 403
        assert (await client.post('/api/speech-output/models/download?model_id=kokoro-v1')).status_code == 403
    await output.close()


@pytest.mark.asyncio
async def test_slow_settings_disk_io_does_not_block_http_health(output, monkeypatch):
    save = output._save
    def slow(value):
        time.sleep(.15)
        save(value)
    monkeypatch.setattr(output, '_save', slow)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        job = asyncio.create_task(client.put('/api/speech-output/settings', json={'mode': 'system'}))
        await asyncio.sleep(.02)
        assert not job.done()
        assert (await asyncio.wait_for(client.get('/health'), .08)).json() == {'ok': True}
        assert (await job).status_code == 200
    await output.close()


@pytest.mark.asyncio
async def test_invalid_local_voice_and_remote_urls_are_rejected(output):
    with pytest.raises(ValueError):
        await output.configure(dict(mode='local', model_id='kokoro-v1', voice='99999'))
    for url in ['file:///etc/passwd', 'http://user:secret@localhost', 'https://example.com?token=secret']:
        with pytest.raises(ValueError):
            await output.configure(dict(mode='remote', provider='openai', base_url=url))
    await output.close()


@pytest.mark.asyncio
async def test_cancel_reaps_active_worker_but_not_worker_owned_by_another_queued_session(output, monkeypatch):
    import sys
    await output.configure(dict(mode='local', model_id='kokoro-v1', voice='46'))
    monkeypatch.setattr(output.resources, 'installed', lambda model_id: True)
    async def start(path):
        code = ("import sys,json,time;sys.stdin.readline();"
                "print(json.dumps({'audio':'AAAA'*30000,'format':'pcm','sample_rate':24000}),flush=True);time.sleep(60)")
        output.runtime.process = await asyncio.create_subprocess_exec(sys.executable, '-c', code,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        output.runtime.model = path
    monkeypatch.setattr(output.runtime, '_start', start)
    first = (await output.start('p', 'alice', 'hello'))['id']
    chunk = await output.next(first, 'p', 'alice')
    assert len(chunk['audio']) > 65536
    proc = output.runtime.process
    second = (await output.start('p', 'bob', 'hello'))['id']
    await asyncio.sleep(.02)
    await output.cancel(second, 'p', 'bob')
    assert proc.returncode is None
    await output.cancel(first, 'p', 'alice')
    assert proc.returncode is not None
    assert output.runtime.process is None
    await output.close()


@pytest.mark.asyncio
async def test_resource_hash_failure_never_publishes_and_leaves_no_staging(output, monkeypatch):
    from services import tts_resources
    real_client = httpx.AsyncClient
    monkeypatch.setattr(tts_resources, 'PACKAGES', [])
    def handler(request):
        if '/tree/' in request.url.path:
            return httpx.Response(200, json=[dict(type='file', path=name, size=4, oid='0' * 40)
                for name in ['model.onnx', 'voices.bin', 'tokens.txt']])
        return httpx.Response(200, content=b'bad!')
    monkeypatch.setattr(tts_resources.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    await output.resources.download('kokoro-v1')
    await output.resources.task
    assert output.resources.states['kokoro-v1']['stage'] == 'error'
    assert not output.resources.installed('kokoro-v1')
    assert not list(output.resources.root.glob('.install-*'))
    await output.close()


@pytest.mark.asyncio
async def test_qwen_adapter_waits_for_configuration_and_streams_audio(monkeypatch):
    from services import tts_remote
    sent = []
    class Socket:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def __aiter__(self): return self.events()
        async def events(self):
            for event in [{'type': 'session.created'}, {'type': 'session.updated'},
                          {'type': 'response.audio.delta', 'delta': 'AAAA'}, {'type': 'response.done'}]:
                yield json.dumps(event)
        async def send(self, message): sent.append(json.loads(message))
    monkeypatch.setattr(tts_remote.websockets, 'connect', lambda *args, **kwargs: Socket())
    from services.speech_output import DEFAULTS
    settings = {**DEFAULTS, 'provider': 'qwen', 'api_key': 'test',
                'model': 'qwen3-tts-instruct-flash-realtime', 'instructions': '温柔地说'}
    events = [event async for event in tts_remote.remote_audio(settings, '你好')]
    assert events[0]['format'] == 'pcm' and events[0]['audio'] == 'AAAA'
    assert [event['type'] for event in sent] == ['session.update', 'input_text_buffer.append', 'input_text_buffer.commit', 'session.finish']
    assert sent[0]['session']['instructions'] == '温柔地说'


@pytest.mark.asyncio
@pytest.mark.parametrize('provider', ['volcengine', 'tencent', 'openai', 'voicebox'])
async def test_http_adapters_decode_expected_protocol_without_exposing_secrets(provider, monkeypatch):
    from services import tts_remote
    from services.speech_output import DEFAULTS
    settings = {**DEFAULTS, 'provider': provider, 'voice': '101001', 'base_url': 'http://localhost/v1',
                'api_key': 'private-key', 'secret_id': 'id', 'secret_key': 'secret'}
    real_client = httpx.AsyncClient
    calls = []
    def handler(request):
        calls.append(request)
        if provider == 'tencent':
            assert request.headers['X-TC-Action'] == 'TextToVoice'
            assert 'TC3-HMAC-SHA256' in request.headers['Authorization']
            return httpx.Response(200, json={'Response': {'Audio': 'AAAA'}})
        if provider == 'volcengine':
            assert request.headers['X-Api-Key'] == 'private-key'
            return httpx.Response(200, content=b'{"code":0,"data":"AAAA"}\n{"code":20000000}\n')
        if provider == 'voicebox':
            assert json.loads(request.content)['personality'] is False
            return httpx.Response(200, content=b'RIFF' + b'\0' * 40)
        assert json.loads(request.content)['response_format'] == 'pcm'
        return httpx.Response(200, content=b'\0\0' * 100)
    monkeypatch.setattr(tts_remote.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    events = [event async for event in tts_remote.remote_audio(settings, '你好')]
    assert events and calls
    assert 'private-key' not in json.dumps(events)


@pytest.mark.asyncio
async def test_local_catalog_has_qwen_variants_and_model_specific_voice_validation(output):
    from services.speech_output import validate
    status = await output.snapshot()
    catalog = {m['id']: m for m in status['models']}
    small = catalog['qwen-06-custom']
    assert small['runtime'] == 'qwen' and not small['instructions']
    assert any(v['id'] == 'Vivian' for v in small['voices'])
    assert catalog['qwen-17-custom']['instructions']
    assert catalog['qwen-17-design']['voice_design']
    assert all(m['streaming'] == 'sentence' for m in catalog.values())
    validate(dict(mode='local', model_id='qwen-06-custom', voice='Vivian'))
    validate(dict(mode='local', model_id='qwen-17-design', voice='design', instructions='年轻清亮的女性声音'))
    for value in [dict(model_id='qwen-06-custom', voice='46'),
                  dict(model_id='qwen-17-design', voice='design'),
                  dict(model_id='qwen-06-custom', voice='Vivian', instructions='开心地说')]:
        with pytest.raises(ValueError):
            validate(dict(mode='local', **value))
    await output.close()


@pytest.mark.asyncio
async def test_local_instructions_are_sent_to_runtime_without_changing_kokoro_protocol(output, monkeypatch):
    received = []
    monkeypatch.setattr(output.resources, 'installed', lambda _: True)
    async def audio(path, text, voice, instructions=''):
        received.append((path.name, text, voice, instructions))
        yield dict(audio='AAAA', format='pcm', sample_rate=24000)
    monkeypatch.setattr(output.runtime, 'audio', audio)
    await output.configure(dict(mode='local', model_id='qwen-17-custom', voice='Serena', instructions='声线清亮。\n温柔地说'))
    sid = (await output.start('p', 'u', '你好'))['id']
    assert (await output.next(sid, 'p', 'u'))['audio']
    assert received == [('qwen-17-custom', '你好', 'Serena', '声线清亮。\n温柔地说')]
    await output.close()


@pytest.mark.asyncio
async def test_qwen_download_checks_nested_weights_reuses_runtime_and_publishes_after_check(output, monkeypatch):
    import hashlib
    from services import tts_resources, tts_qwen_resources
    real_client = httpx.AsyncClient
    files = {name: b'weights-or-config' for name in ['model.safetensors', 'config.json', 'speech_tokenizer/model.safetensors']}
    def handler(request):
        if '/tree/' in request.url.path:
            return httpx.Response(200, json=[dict(type='file', path=name, size=len(data),
                lfs=dict(oid=hashlib.sha256(data).hexdigest())) for name, data in files.items()])
        for name, data in files.items():
            if request.url.path.endswith('/' + name):
                return httpx.Response(200, content=data)
        raise AssertionError(request.url)
    monkeypatch.setattr(tts_resources.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    calls = []
    async def ensure(root, state):
        calls.append(('runtime', root))
    async def run(command, **kwargs):
        calls.append(('check', command))
        assert not output.resources.installed('qwen-06-custom')
    monkeypatch.setattr(tts_qwen_resources, 'ensure', ensure)
    monkeypatch.setattr(tts_qwen_resources, 'installed', lambda root: True)
    monkeypatch.setattr(tts_qwen_resources, 'worker_command', lambda path, check: ['python', str(path), '--check'])
    monkeypatch.setattr(tts_qwen_resources, 'run', run)
    await output.resources.download('qwen-06-custom')
    await output.resources.task
    assert output.resources.states['qwen-06-custom']['stage'] == 'installed'
    assert output.resources.installed('qwen-06-custom')
    assert len(calls) == 2
    assert (output.resources.path('qwen-06-custom') / 'speech_tokenizer/model.safetensors').read_bytes() == files['speech_tokenizer/model.safetensors']
    await output.resources.delete('qwen-06-custom')
    assert not output.resources.installed('qwen-06-custom')
    await output.close()


@pytest.mark.asyncio
async def test_qwen_installer_slow_process_does_not_block_health_and_cancellation_reaps_late_spawn(monkeypatch):
    import sys
    from services import tts_qwen_resources
    actual = asyncio.create_subprocess_exec
    processes = []
    async def delayed(*args, **kwargs):
        await asyncio.sleep(.04)
        proc = await actual(*args, **kwargs)
        processes.append(proc)
        return proc
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', delayed)
    task = asyncio.create_task(tts_qwen_resources.run([sys.executable, '-c', 'import time;time.sleep(60)']))
    await asyncio.sleep(.01)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        assert (await asyncio.wait_for(client.get('/health'), .05)).status_code == 200
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(processes) == 1 and processes[0].returncode is not None


def test_qwen_worker_dispatches_custom_and_design_and_converts_pcm(monkeypatch):
    import sys
    from types import SimpleNamespace
    import importlib.util
    # The worker dependencies are deliberately absent from daemon Python.
    # Supply tiny arrays to test request dispatch without installing torch here.
    path = __import__('pathlib').Path(__file__).parents[1] / 'services/tts_qwen_worker.py'
    spec = importlib.util.spec_from_file_location('private_qwen_worker', path)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    calls = []
    class Samples:
        def reshape(self, *args): return self
        def __mul__(self, value): return self
        def astype(self, value):
            assert value == '<i2'
            return self
        def tobytes(self): return b'\x00\x00'
    monkeypatch.setitem(sys.modules, 'numpy', SimpleNamespace(asarray=lambda *args, **kwargs: Samples(), float32=float, clip=lambda *args: Samples()))
    monkeypatch.setitem(sys.modules, 'librosa', SimpleNamespace())
    def generate(**kwargs):
        calls.append(kwargs)
        return [[0]], 24000
    model = SimpleNamespace(model=SimpleNamespace(tts_model_type='custom_voice'), generate_custom_voice=generate, generate_voice_design=generate)
    assert worker.synthesize(model, dict(text='你好', voice='Serena', instructions='温柔')) == b'\x00\x00'
    assert calls[-1]['speaker'] == 'Serena' and calls[-1]['instruct'] == '温柔'
    model.model.tts_model_type = 'voice_design'
    worker.synthesize(model, dict(text='你好', voice='design', instructions='年轻女声'))
    assert 'speaker' not in calls[-1] and calls[-1]['instruct'] == '年轻女声'


@pytest.mark.asyncio
async def test_qwen_bootstrap_rejects_bad_wheel_before_running_installer(tmp_path, monkeypatch):
    from services import tts_qwen_resources
    from packaging.tags import sys_tags
    tag = next(sys_tags())
    filename = f'uv-0.9.26-{tag.interpreter}-{tag.abi}-{tag.platform}.whl'
    real_client = httpx.AsyncClient
    def handler(request):
        if request.url.host == 'pypi.org':
            return httpx.Response(200, json={'urls': [dict(filename=filename, url='https://files.pythonhosted.org/uv.whl', size=4, digests={'sha256': '0' * 64})]})
        return httpx.Response(200, content=b'bad!')
    monkeypatch.setattr(tts_qwen_resources.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    async def forbidden(*args, **kwargs):
        pytest.fail('unverified native code must never run')
    monkeypatch.setattr(tts_qwen_resources, 'run', forbidden)
    with pytest.raises(ValueError, match='校验失败'):
        await tts_qwen_resources.ensure(tmp_path, {})
    assert not list(tmp_path.iterdir())


@pytest.mark.asyncio
async def test_qwen_runtime_uses_private_managed_python_and_reuses_verified_install(tmp_path, monkeypatch):
    import hashlib
    import io
    import os
    import zipfile
    from pathlib import Path
    from packaging.tags import sys_tags
    from services import tts_qwen_resources
    tag = next(sys_tags())
    filename = f'uv-0.9.26-{tag.interpreter}-{tag.abi}-{tag.platform}.whl'
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('uv.data/scripts/' + ('uv.exe' if os.name == 'nt' else 'uv'), b'native-uv')
    blob = buffer.getvalue()
    actual = httpx.AsyncClient
    requests, commands = [], []
    def handler(request):
        requests.append(request.url)
        if request.url.host == 'pypi.org':
            return httpx.Response(200, json={'urls': [dict(filename=filename, url='https://files.pythonhosted.org/uv.whl', size=len(blob), digests={'sha256': hashlib.sha256(blob).hexdigest()})]})
        return httpx.Response(200, content=blob)
    python = tmp_path / 'python/bin/python3.12'
    async def run(command, **kwargs):
        commands.append(list(map(str, command)))
        if 'find' in command:
            assert '--system' in command and '--no-project' in command and '--managed-python' in command
            return str(python)
        if 'python' in command and 'install' in command:
            assert kwargs['env']['UV_PYTHON_BIN_DIR'] == str(tmp_path / 'python-bin')
            python.parent.mkdir(parents=True)
            python.write_bytes(b'python')
        if 'pip' in command:
            assert command[command.index('--python') + 1] == str(python)
            lib = Path(command[command.index('--target') + 1])
            for name in ['qwen_tts', 'torch', 'transformers']:
                (lib / name).mkdir(parents=True, exist_ok=True)
        return ''
    monkeypatch.setattr(tts_qwen_resources.httpx, 'AsyncClient', lambda **kwargs: actual(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(tts_qwen_resources, 'run', run)
    await tts_qwen_resources.ensure(tmp_path, {})
    assert tts_qwen_resources.installed(tmp_path)
    count = len(requests)
    await tts_qwen_resources.ensure(tmp_path, {})
    assert len(requests) == count
    assert not list(tmp_path.glob('.qwen-runtime-*'))
    assert len(commands) == 5


def test_voice_prompt_accepts_multiline_but_connection_fields_reject_line_breaks():
    from services.speech_output import validate
    prompt = '声线清亮。\n语气温柔，停顿自然。'
    assert validate(dict(mode='local', model_id='qwen-17-custom', voice='Serena', instructions=prompt))['instructions'] == prompt
    with pytest.raises(ValueError):
        validate(dict(api_key='key\nheader'))
