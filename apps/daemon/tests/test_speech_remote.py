import asyncio
import base64
import json
import time

import httpx
import pytest
from fastapi import FastAPI
from api import speech
from services.speech import SpeechService


@pytest.mark.asyncio
async def test_remote_config_encrypts_secrets_and_requires_no_local_model(tmp_path, monkeypatch):
    service = SpeechService(tmp_path)
    monkeypatch.setattr(speech, 'service', service)
    monkeypatch.setattr(speech, 'authorize', lambda *args, **kwargs: None)
    app = FastAPI(); app.include_router(speech.router)
    @app.get('/health')
    async def health(): return {'ok': True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        body = dict(enabled=True, connection=dict(mode='remote', provider='openai', base_url='http://localhost:9988/v1', model='whisper-1', api_key='private-key'))
        result = await client.put('/api/speech/settings', json=body)
        assert result.status_code == 200
        status = result.json()
        assert status['connection']['mode'] == 'remote'
        assert status['ready'] and status['streaming'] == 'final'
        assert 'private-key' not in json.dumps(status)
        assert status['connection']['has_api_key']
        assert 'private-key' not in (tmp_path/'settings.json').read_text()
        reloaded = SpeechService(tmp_path)
        assert (await reloaded.get_settings())['connection']['api_key'] == 'private-key'
        body['connection']['api_key'] = None
        assert (await client.put('/api/speech/settings', json=body)).status_code == 200
        assert (await service.get_settings())['connection']['api_key'] == 'private-key'
        body['connection'].pop('api_key')
        await client.put('/api/speech/settings', json=body)
        assert (await service.get_settings())['connection']['api_key'] == 'private-key'
        body['connection']['base_url'] = 'http://other-host/v1'
        await client.put('/api/speech/settings', json=body)
        assert not (await service.get_settings())['connection']['api_key']
    await service.close()


@pytest.mark.asyncio
async def test_remote_http_recording_is_scoped_nonblocking_and_uses_complete_wav(tmp_path, monkeypatch):
    from services import speech_remote
    service = SpeechService(tmp_path)
    await service.configure(True, 'auto', connection=dict(mode='remote', provider='openai', base_url='http://localhost:9988/v1', model='whisper-1', api_key='key'))
    real = httpx.AsyncClient
    async def handler(request):
        await asyncio.sleep(.1)
        assert request.url.path == '/v1/audio/transcriptions'
        assert request.headers['Authorization'] == 'Bearer key'
        assert b'RIFF' in request.content and b'whisper-1' in request.content
        return httpx.Response(200, json={'text':'远程识别成功'})
    monkeypatch.setattr(speech_remote.httpx, 'AsyncClient', lambda **kwargs: real(transport=httpx.MockTransport(handler), **kwargs))
    sid = (await service.start('p', 'alice'))['id']
    first = await service.audio(sid, 'p', 'alice', 0, b'\0\0'*100, False)
    assert first['text'] == ''
    with pytest.raises(LookupError): await service.audio(sid, 'p', 'bob', 1, b'', True)
    task = asyncio.create_task(service.audio(sid, 'p', 'alice', 1, b'\0\0'*100, True))
    started = time.monotonic(); await asyncio.sleep(.01)
    assert time.monotonic() - started < .08 and not task.done()
    assert (await task)['text'] == '远程识别成功'
    assert not service.sessions and not service.workers
    await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('provider', ['tencent', 'volcengine'])
async def test_cloud_websocket_signing_protocol_incremental_text_and_cleanup(provider, monkeypatch):
    from services import speech_remote
    import gzip, struct
    from urllib.parse import urlsplit, parse_qsl
    import hashlib, hmac
    events = asyncio.Queue(); calls = []; closed = []
    def response(text, final=False):
        data = gzip.compress(json.dumps({'result': {'text': text}}).encode())
        return bytes([0x11, 0x93 if final else 0x91, 0x11, 0]) + struct.pack('>iI', -2 if final else 1, len(data)) + data
    class Socket:
        async def recv(self):
            if provider == 'tencent': return '{"code":0}'
            return await events.get()
        async def send(self, data):
            calls.append(data)
            if provider == 'tencent':
                await events.put(json.dumps({'code':0, 'final': 1} if isinstance(data, str) else
                    {'code':0,'result':{'index':0,'slice_type':1,'voice_text_str':'腾讯实时识别'}}))
            elif data[1] >> 4 == 1:
                config = json.loads(gzip.decompress(data[12:]))
                assert config['audio']['rate'] == 16000 and config['request']['result_type'] == 'full'
                await events.put(response(''))
            else:
                await events.put(response('火山实时识别', bool(data[1] & 2)))
        def __aiter__(self): return self
        async def __anext__(self): return await events.get()
        async def close(self): closed.append(True)
    async def connect(url, **kwargs):
        if provider == 'tencent':
            parsed = urlsplit(url); params = dict(parse_qsl(parsed.query)); signature = params.pop('signature')
            original = parsed.netloc + parsed.path + '?' + '&'.join(f'{k}={v}' for k,v in sorted(params.items()))
            expected = base64.b64encode(hmac.new(b'secret', original.encode(), hashlib.sha1).digest()).decode()
            assert signature == expected and params['voice_format'] == '1'
        else:
            assert kwargs['additional_headers']['X-Api-Key'] == 'key'
            assert url.endswith('/bigmodel_async')
        return Socket()
    monkeypatch.setattr(speech_remote.websockets, 'connect', connect)
    runtime = speech_remote.RemoteSpeechRuntime(dict(provider=provider, model='16k_zh', app_id='123', secret_id='id', secret_key='secret', api_key='key', resource_id='resource'))
    assert '实时识别' in await runtime.infer(b'\0\0'*100, False)
    assert '实时识别' in await runtime.infer(b'', True)
    await runtime.close()
    assert closed and runtime.reader is None and runtime.socket is None


@pytest.mark.asyncio
async def test_slow_connection_settings_do_not_block_health_and_network_errors_are_redacted(tmp_path, monkeypatch):
    from services import speech_connection, speech_remote
    service = SpeechService(tmp_path)
    monkeypatch.setattr(speech, 'service', service)
    monkeypatch.setattr(speech, 'authorize', lambda *args, **kwargs: None)
    original = speech_connection.save
    def slow(*args): time.sleep(.15); return original(*args)
    monkeypatch.setattr(speech_connection, 'save', slow)
    app = FastAPI(); app.include_router(speech.router)
    @app.get('/health')
    async def health(): return {'ok':True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        job = asyncio.create_task(client.put('/api/speech/settings', json=dict(enabled=True, connection=dict(mode='remote', provider='openai', base_url='http://localhost/v1', model='whisper-1'))))
        await asyncio.sleep(.02)
        assert (await asyncio.wait_for(client.get('/health'), .08)).status_code == 200
        assert (await job).status_code == 200
    real = httpx.AsyncClient
    def error(request): raise RuntimeError('private-key secretid=secret')
    monkeypatch.setattr(speech_remote.httpx, 'AsyncClient', lambda **kwargs: real(transport=httpx.MockTransport(error), **kwargs))
    sid = (await service.start('p','a'))['id']
    with pytest.raises(ValueError) as exc:
        await service.audio(sid,'p','a',0,b'\0\0',True)
    assert 'private-key' not in str(exc.value) and 'secretid' not in str(exc.value)
    assert not service.sessions and not service.workers
    await service.close()


@pytest.mark.asyncio
async def test_cancel_inflight_remote_inference_releases_owned_session_only(tmp_path, monkeypatch):
    from services import speech_remote
    service = SpeechService(tmp_path)
    await service.configure(True, 'auto', connection=dict(mode='remote', provider='openai', base_url='http://localhost/v1',model='whisper'))
    real = httpx.AsyncClient
    started = asyncio.Event(); cancelled = asyncio.Event()
    async def slow(request):
        started.set()
        try: await asyncio.sleep(60)
        finally: cancelled.set()
    monkeypatch.setattr(speech_remote.httpx, 'AsyncClient', lambda **kwargs: real(transport=httpx.MockTransport(slow), **kwargs))
    a=(await service.start('p','alice'))['id'];b=(await service.start('p','bob'))['id']
    task=asyncio.create_task(service.audio(a,'p','alice',0,b'\0\0',True))
    await started.wait()
    await asyncio.wait_for(service.cancel(a,'p','alice'),.2)
    with pytest.raises(LookupError): await task
    assert cancelled.is_set() and b in service.sessions and a not in service.sessions
    await service.close()


@pytest.mark.asyncio
async def test_cancel_during_settings_commit_keeps_disk_and_cache_consistent(tmp_path, monkeypatch):
    from services import speech_connection
    service=SpeechService(tmp_path)
    await service.get_settings()
    original=speech_connection.save
    def slow(*args):time.sleep(.08);original(*args)
    monkeypatch.setattr(speech_connection,'save',slow)
    saving=asyncio.create_task(service.configure(True,'auto',connection=dict(mode='remote',provider='openai',base_url='http://localhost/v1',model='whisper')))
    await asyncio.sleep(.02);saving.cancel()
    with pytest.raises(asyncio.CancelledError):await saving
    await asyncio.sleep(.1)
    reloaded=SpeechService(tmp_path)
    assert (await service.get_settings())['connection']==(await reloaded.get_settings())['connection']
    await service.close()
