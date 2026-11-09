"""Speech uses real HTTP boundaries; slow inference must not block health."""
import asyncio
import base64
import time

import httpx
import pytest
from fastapi import FastAPI

from api import speech
from services.speech import SpeechService


@pytest.fixture
def service(tmp_path, monkeypatch):
    instance = SpeechService(tmp_path)
    monkeypatch.setattr(speech, 'service', instance)
    monkeypatch.setattr(speech, 'authorize', lambda project_id, manage=False: None)
    return instance


@pytest.mark.asyncio
async def test_recording_is_scoped_sequenced_bounded_and_nonblocking(service, monkeypatch):
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    async def infer(pcm, session_id, final):
        await asyncio.to_thread(time.sleep, .12)
        return '粤语测试'
    monkeypatch.setattr(service, 'infer', infer)
    app = FastAPI()
    app.include_router(speech.router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        r = await client.post('/api/speech/sessions?project_id=p', json={})
        assert r.status_code == 200
        sid = r.json()['id']
        pcm = base64.b64encode(b'\x01\x02' * 16000).decode()
        path = f'/api/speech/sessions/{sid}/audio'
        assert (await client.post(path+'?project_id=other', json={'sequence': 0, 'audio': pcm})).status_code == 404
        job = asyncio.create_task(client.post(path+'?project_id=p', json={'sequence': 0, 'audio': pcm, 'final': True}))
        await asyncio.sleep(.02)
        assert not job.done()
        assert (await asyncio.wait_for(client.get('/health'), .08)).json() == {'ok': True}
        result = await job
        assert result.status_code == 200
        assert result.json()['text'] == '粤语测试'
        assert result.json()['final'] is True
        assert not service.sessions
    await service.close()


@pytest.mark.asyncio
async def test_cancel_discards_late_result_and_blocks_model_mutation(service, monkeypatch):
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    sid = (await service.start('p', 'owner'))['id']
    with pytest.raises(ValueError, match='录音'):
        await service.delete()
    await service.cancel(sid, 'p', 'owner')
    with pytest.raises(LookupError):
        await service.audio(sid, 'p', 'owner', 0, b'\0\0', True)
    await service.close()


@pytest.mark.asyncio
async def test_bad_audio_sequence_and_duration_leave_draft_untouched(service, monkeypatch):
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    sid = (await service.start('p', 'owner'))['id']
    with pytest.raises(ValueError, match='顺序'):
        await service.audio(sid, 'p', 'owner', 2, b'\0\0', False)
    with pytest.raises(ValueError, match='音频'):
        await service.audio(sid, 'p', 'owner', 0, b'\0', False)
    await service.close()


@pytest.mark.asyncio
async def test_install_failure_never_becomes_installed(service, monkeypatch):
    async def broken(stage):
        raise ValueError('校验失败')
    monkeypatch.setattr(service, '_install', broken)
    await service.download()
    await service.download_task
    assert service.install_state['stage'] == 'error'
    assert not service.installed()
    await service.close()


@pytest.mark.asyncio
async def test_download_hash_failure_and_cancel_remove_staging_files(service, monkeypatch):
    async def bad_download(stage):
        (stage / 'partial').write_bytes(b'incomplete')
        raise ValueError('checksum')
    monkeypatch.setattr(service, '_install', bad_download)
    await service.download()
    await service.download_task
    assert list(service.root.glob('.install-*')) == []
    gate = asyncio.Event()
    async def slow_download(stage):
        await gate.wait()
    monkeypatch.setattr(service, '_install', slow_download)
    await service.download()
    await asyncio.sleep(.01)
    await service.cancel_download()
    assert service.install_state['stage'] == 'cancelled'
    assert not service.installed()
    assert list(service.root.glob('.install-*')) == []
    await service.close()


def test_project_read_actor_cannot_record_or_manage_models():
    from services.remote_access import ActorSnapshot, _current_actor
    actor = ActorSnapshot(actor_id='u', user_name='user', device_id='d', device_name='device',
                          source='managed', project_id='p', access_level='read')
    token = _current_actor.set(actor)
    try:
        with pytest.raises(speech.HTTPException) as denied:
            speech.authorize('p')
        assert denied.value.status_code == 403
        with pytest.raises(speech.HTTPException):
            speech.authorize('other')
        with pytest.raises(speech.HTTPException):
            speech.authorize('', manage=True)
    finally:
        _current_actor.reset(token)


def test_runtime_wheels_reject_traversal_and_startup_hooks(tmp_path):
    import zipfile
    from services.speech import unpack_wheel
    for filename in ['../escape.py', '/escape.py', 'evil.pth']:
        archive = tmp_path / 'test.whl'
        with zipfile.ZipFile(archive, 'w') as wheel:
            wheel.writestr(filename, 'bad')
        with pytest.raises(ValueError):
            unpack_wheel(archive, tmp_path / 'runtime')


@pytest.mark.asyncio
async def test_resource_download_verifies_hash_before_accepting(service, tmp_path):
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=b'wrong'))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(ValueError, match='校验'):
            await service._fetch(client, 'https://example.com/model', tmp_path/'model', 5, '0'*64)


@pytest.mark.asyncio
async def test_silence_tail_does_not_duplicate_final_punctuation(service, monkeypatch):
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    results = iter(['粤语测试。', '粤语测试。'])
    async def infer(pcm, session_id, final):
        return next(results)
    monkeypatch.setattr(service, 'infer', infer)
    sid = (await service.start('p', 'owner'))['id']
    first = await service.audio(sid, 'p', 'owner', 0, b'\0\0' * 16000, False)
    assert first['text'] == '粤语测试。'
    final = await service.audio(sid, 'p', 'owner', 1, b'\0\0' * 2000, True)
    assert final['text'] == '粤语测试。'
    await service.close()


@pytest.mark.asyncio
async def test_half_second_preview_is_replaced_by_final_hypothesis(service, monkeypatch):
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    calls = []
    async def infer(pcm, session_id, final):
        calls.append(len(pcm))
        return '识别临时词' if len(calls) == 1 else '识别正确词。'
    monkeypatch.setattr(service, 'infer', infer)
    sid = (await service.start('p', 'owner'))['id']
    try:
        preview = await service.audio(sid, 'p', 'owner', 0, b'\x00\x10' * 8000, False)
        assert preview['text'] == '识别临时词'
        assert preview['final'] is False
        result = await service.audio(sid, 'p', 'owner', 1, b'\x00\x10' * 4000, True)
        assert result['text'] == '识别正确词。'
        assert calls == [16000, 8000]
        assert not service.sessions
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_default_is_native_streaming_and_legacy_language_migrates(service):
    service.root.mkdir(parents=True, exist_ok=True)
    (service.root / 'settings.json').write_text('{"enabled": true, "language": "ja"}')
    snapshot = await service.snapshot()
    assert snapshot['model_id'] == 'streaming-paraformer-zh-yue-en-int8'
    assert snapshot['models'][0]['streaming'] == 'native'
    assert snapshot['models'][0]['languages'] == ['zh', 'yue', 'en']
    assert snapshot['languages'] == ['auto']
    assert snapshot['language'] == 'auto'
    assert snapshot['enabled'] is True
    assert snapshot['models'][0]['installed'] is False
    await service.close()


@pytest.mark.asyncio
async def test_old_model_resources_are_not_treated_as_installed_or_deleted(service):
    old = service.root / 'sensevoice-small-int8'
    old.mkdir(parents=True)
    (old / 'installed.json').write_text('{"version":"1"}')
    (old / 'model.int8.onnx').write_bytes(b'old resource')
    assert not service.installed()
    await service.delete()
    assert (old / 'model.int8.onnx').read_bytes() == b'old resource'
    await service.close()


@pytest.mark.asyncio
async def test_decoder_failure_releases_session_for_next_recording(service, monkeypatch):
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    async def fail(pcm, session_id, final):
        raise ValueError('语音识别失败')
    monkeypatch.setattr(service, 'infer', fail)
    first = (await service.start('p', 'owner'))['id']
    with pytest.raises(ValueError, match='识别失败'):
        await service.audio(first, 'p', 'owner', 0, b'\0\0' * 8000, False)
    assert not service.sessions
    second = (await service.start('p', 'owner'))['id']
    assert first != second
    await service.close()


@pytest.mark.asyncio
async def test_concurrent_recordings_are_owned_scoped_and_cancel_independently(service, monkeypatch):
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    first = (await service.start('p1', 'alice'))['id']
    second = (await service.start('p2', 'bob'))['id']
    third = (await service.start('p1', 'alice'))['id']
    assert len({first, second, third}) == 3
    for sid, project, owner in [(first, 'p1', 'bob'), (first, 'p2', 'alice'), (second, 'p1', 'alice')]:
        with pytest.raises(LookupError):
            await service.cancel(sid, project, owner)
    await service.cancel(first, 'p1', 'alice')
    async def infer(pcm, sid, final):
        await asyncio.sleep(.01)
        return {second: 'Bob的录音', third: 'Alice第二段'}[sid]
    monkeypatch.setattr(service, 'infer', infer)
    results = await asyncio.gather(service.audio(second, 'p2', 'bob', 0, b'\0\0', True),
                                   service.audio(third, 'p1', 'alice', 0, b'\0\0', True))
    assert [(r['id'], r['text']) for r in results] == [(second, 'Bob的录音'), (third, 'Alice第二段')]
    assert not service.sessions
    await service.close()


@pytest.mark.asyncio
async def test_recording_capacity_is_bounded_and_returns_after_cancel(service, monkeypatch):
    from services.speech import MAX_SESSIONS
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    sessions = [(await service.start('p', 'owner'))['id'] for _ in range(MAX_SESSIONS)]
    with pytest.raises(ValueError, match='并发'):
        await service.start('p', 'other')
    await service.cancel(sessions[0], 'p', 'owner')
    assert (await service.start('p', 'other'))['id'] not in sessions
    await service.close()


@pytest.mark.asyncio
async def test_real_worker_pipes_isolate_users_and_cancel_only_one_decoder(service, monkeypatch, tmp_path):
    import sys
    from services.remote_access import ActorSnapshot, actor_context
    worker = tmp_path / 'worker.py'
    worker.write_text('''import sys,json,time,base64
for line in sys.stdin:
 r=json.loads(line)
 if base64.b64decode(r['audio'])[:1] == b'\\x01': time.sleep(2)
 if base64.b64decode(r['audio'])[:1] == b'\\x03': sys.exit(1)
 print(json.dumps({'session_id':r['session_id'],'text':r['session_id']}),flush=True)
''')
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    monkeypatch.setattr(service, 'worker_command', lambda: [sys.executable, '-u', str(worker)])
    app = FastAPI()
    app.include_router(speech.router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        async def call(user, method, path, **kwargs):
            with actor_context(ActorSnapshot(actor_id=user, user_name=user, device_id='phone', device_name='phone', source='managed')):
                return await client.request(method, path, **kwargs)
        a = (await call('alice', 'POST', '/api/speech/sessions?project_id=p')).json()['id']
        b = (await call('bob', 'POST', '/api/speech/sessions?project_id=p')).json()['id']
        path_a = f'/api/speech/sessions/{a}/audio?project_id=p'
        path_b = f'/api/speech/sessions/{b}/audio?project_id=p'
        assert (await call('bob', 'POST', path_a, json={'sequence': 0, 'audio': '', 'final': True})).status_code == 404
        slow = asyncio.create_task(call('alice', 'POST', path_a, json={'sequence': 0, 'audio': base64.b64encode(b'\x01\0'*8000).decode(), 'final': False}))
        for _ in range(100):
            if service.sessions[a]['worker'].process:
                break
            await asyncio.sleep(.005)
        assert (await asyncio.wait_for(client.get('/health'), .08)).status_code == 200
        fast = await asyncio.wait_for(call('bob', 'POST', path_b, json={'sequence': 0, 'audio': '', 'final': False}), .5)
        assert fast.json()['text'] == b
        assert not slow.done()
        b_pid = service.sessions[b]['worker'].process.pid
        crashing = (await call('alice', 'POST', '/api/speech/sessions?project_id=p')).json()['id']
        crash = await call('alice', 'POST', f'/api/speech/sessions/{crashing}/audio?project_id=p',
                           json={'sequence': 0, 'audio': base64.b64encode(b'\x03\0').decode(), 'final': True})
        assert crash.status_code == 409
        assert '进程已退出' in crash.json()['detail']
        assert (await call('bob', 'DELETE', f'/api/speech/sessions/{a}?project_id=p')).status_code == 404
        assert (await call('alice', 'DELETE', f'/api/speech/sessions/{a}?project_id=p')).status_code == 200
        assert (await slow).status_code in (404, 409)
        assert service.sessions[b]['worker'].process.pid == b_pid
        final = await call('bob', 'POST', path_b, json={'sequence': 1, 'audio': '', 'final': True})
        assert final.json() == {'id': b, 'sequence': 1, 'text': b, 'final': True}
    await service.close()


@pytest.mark.asyncio
async def test_punctuation_upgrade_reuses_verified_asr_and_keeps_event_loop_responsive(service, monkeypatch, tmp_path):
    import hashlib
    import services.speech as module
    monkeypatch.setattr(module, 'MODEL_FILES', [('encoder', 3, hashlib.sha256(b'asr').hexdigest())])
    service.bundle.mkdir(parents=True)
    (service.bundle / 'encoder').write_bytes(b'asr')
    (service.bundle / 'runtime').mkdir()
    (service.bundle / 'runtime' / 'dependency').write_text('keep')
    monkeypatch.setattr(service, 'installed', lambda: True)
    original_copy = module.shutil.copytree
    def slow_copy(*args, **kwargs):
        time.sleep(.1)
        return original_copy(*args, **kwargs)
    monkeypatch.setattr(module.shutil, 'copytree', slow_copy)
    fetched = []
    async def fetch(client, url, path, size, digest):
        fetched.append(path.name)
        path.write_bytes(b'punctuation')
    monkeypatch.setattr(service, '_fetch', fetch)
    stage = tmp_path / 'upgrade'
    stage.mkdir()
    job = asyncio.create_task(service._install(stage))
    await asyncio.sleep(.01)
    assert not job.done()
    await asyncio.wait_for(asyncio.sleep(0), .05)
    await job
    assert fetched == ['punctuation.int8.onnx']
    assert (stage / 'encoder').read_bytes() == b'asr'
    assert (stage / 'runtime' / 'dependency').read_text() == 'keep'
    assert (service.bundle / 'encoder').read_bytes() == b'asr'
    await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('final_arrives_first', [False, True])
async def test_final_audio_can_pipeline_behind_inflight_preview(service, monkeypatch, final_arrives_first):
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []
    async def infer(pcm, sid, final):
        calls.append((pcm, final))
        if not final:
            entered.set()
            await release.wait()
        return '定稿。' if final else '临时'
    monkeypatch.setattr(service, 'infer', infer)
    sid = (await service.start('p', 'owner'))['id']
    finish = None
    if final_arrives_first:
        finish = asyncio.create_task(service.audio(sid, 'p', 'owner', 1, b'\x02\0', True))
        await asyncio.sleep(.01)
        assert not finish.done()
    preview = asyncio.create_task(service.audio(sid, 'p', 'owner', 0, b'\x01\0', False))
    await entered.wait()
    if finish is None:
        finish = asyncio.create_task(service.audio(sid, 'p', 'owner', 1, b'\x02\0', True))
    await asyncio.sleep(.01)
    assert not finish.done()
    await asyncio.wait_for(asyncio.sleep(0), .05)
    release.set()
    assert (await preview)['text'] == '临时'
    assert (await finish)['text'] == '定稿。'
    assert calls == [(b'\x01\0', False), (b'\x02\0', True)]
    assert not service.sessions
    await service.close()


@pytest.mark.asyncio
async def test_queued_final_is_bounded_and_cancellation_releases_waiter(service, monkeypatch):
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    sid = (await service.start('p', 'owner'))['id']
    final = asyncio.create_task(service.audio(sid, 'p', 'owner', 1, b'', True))
    await asyncio.sleep(.01)
    with pytest.raises(ValueError, match='重复'):
        await service.audio(sid, 'p', 'owner', 1, b'', True)
    with pytest.raises(LookupError):
        await service.audio(sid, 'p', 'other', 1, b'', True)
    await service.cancel(sid, 'p', 'owner')
    with pytest.raises(LookupError):
        await asyncio.wait_for(final, .1)
    await service.close()
