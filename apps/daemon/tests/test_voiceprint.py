import asyncio
import base64
import time

import httpx
import pytest
from fastapi import FastAPI

from api import speech
from services.speech import MODEL_ID, SpeechService
from services.voiceprint import VoiceprintService


@pytest.mark.asyncio
async def test_enrollment_is_encrypted_and_bad_retake_preserves_profile(tmp_path, monkeypatch):
    service = VoiceprintService(tmp_path, lambda: tmp_path / 'runtime')
    monkeypatch.setattr(service, 'available', lambda: True)
    async def extract(pcm):
        return {'embedding': [1., 0., 0.], 'voiced_samples': 96000}
    monkeypatch.setattr(service, 'extract', extract)
    await service.enroll(b'\x01\x02' * 96000)
    await service.configure(True, 'calls')
    restored = VoiceprintService(tmp_path, lambda: tmp_path / 'runtime')
    assert (await restored.snapshot())['enrolled']
    assert (await service.profile())['enabled']
    assert b'embedding' not in (tmp_path / 'voiceprint' / 'profile.enc').read_bytes()
    assert not list(tmp_path.rglob('*.wav'))
    async def bad(pcm):
        return {'embedding': [0., 1., 0.], 'voiced_samples': 100}
    monkeypatch.setattr(service, 'extract', bad)
    with pytest.raises(ValueError):
        await service.enroll(b'\x01\x02' * 96000)
    assert (await service.profile())['embedding'] == [1., 0., 0.]
    await service.delete()
    assert not (await service.snapshot())['enrolled']
    assert not (await service.profile())['enabled']


@pytest.mark.asyncio
async def test_verification_rejects_other_speakers_and_insufficient_audio(tmp_path, monkeypatch):
    service = VoiceprintService(tmp_path, lambda: tmp_path / 'runtime')
    monkeypatch.setattr(service, 'available', lambda: True)
    async def extract(pcm):
        return {'embedding': [1., 0., 0.], 'voiced_samples': 96000}
    monkeypatch.setattr(service, 'extract', extract)
    await service.enroll(b'\x01\x02' * 96000)
    assert await service.verify(b'\x01\x02' * 32000) == 'matched'
    async def other(pcm):
        return {'embedding': [0., 1., 0.], 'voiced_samples': 32000}
    monkeypatch.setattr(service, 'extract', other)
    assert await service.verify(b'\x01\x02' * 32000) == 'unmatched'
    async def silence(pcm):
        return {'embedding': [], 'voiced_samples': 0}
    monkeypatch.setattr(service, 'extract', silence)
    assert await service.verify(b'\0\0' * 32000) == 'insufficient'
    with pytest.raises(ValueError):
        await service.enroll(b'\0' * (640000 + 2))


@pytest.mark.asyncio
async def test_filter_never_exposes_unverified_previews_and_final_rechecks(tmp_path, monkeypatch):
    service = SpeechService(tmp_path, MODEL_ID)
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    async def profile():
        return {'enabled': True, 'scope': 'all', 'embedding': [1., 0., 0.]}
    monkeypatch.setattr(service.voiceprint, 'profile', profile)
    monkeypatch.setattr(service.voiceprint, 'available', lambda: True)
    seen = []
    async def infer(pcm, sid, final, preview=True):
        seen.append((len(pcm), final, preview))
        return '旁人的话' if preview else ''
    monkeypatch.setattr(service, 'infer', infer)
    checks = []
    async def verify(pcm, profile=None):
        checks.append(len(pcm))
        return 'matched' if len(checks) == 1 else 'unmatched'
    monkeypatch.setattr(service.voiceprint, 'verify', verify)
    sid = (await service.start('p', 'owner'))['id']
    first = await service.audio(sid, 'p', 'owner', 0, b'\x01\x02' * 4000, False)
    assert first['text'] == ''
    assert seen[-1][-1] is False
    preview = await service.audio(sid, 'p', 'owner', 1, b'\x01\x02' * 24000, False)
    assert preview['speaker_status'] == 'matched'
    final = await service.audio(sid, 'p', 'owner', 2, b'\x01\x02' * 16000, True)
    assert final['text'] == '' and final['speaker_status'] == 'unmatched'
    assert checks == [56000, 88000]
    assert not service.sessions
    await service.close()


@pytest.mark.asyncio
async def test_voiceprint_host_api_keeps_event_loop_responsive(tmp_path, monkeypatch):
    service = SpeechService(tmp_path, MODEL_ID)
    monkeypatch.setattr(speech, 'service', service)
    monkeypatch.setattr(speech, 'authorize', lambda *args, **kwargs: None)
    monkeypatch.setattr(service.voiceprint, 'available', lambda: True)
    async def extract(pcm):
        await asyncio.to_thread(time.sleep, .15)
        return {'embedding': [1., 0., 0.], 'voiced_samples': 96000}
    monkeypatch.setattr(service.voiceprint, 'extract', extract)
    app = FastAPI(); app.include_router(speech.router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
        job = asyncio.create_task(client.post('/api/speech/voiceprint/enroll', json={'audio': base64.b64encode(b'\x01\x02' * 96000).decode()}))
        await asyncio.sleep(.02)
        assert not job.done()
        assert (await asyncio.wait_for(client.get('/health'), .08)).json()['ok']
        response = await job
        assert response.status_code == 200, response.text
        assert response.json()['enrolled']
        assert 'embedding' not in response.json()
        assert (await client.post('/api/speech/voiceprint/test', json={'audio': 'bad'})).status_code == 422
    await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('project_access', [None, 'read', 'edit'])
@pytest.mark.parametrize('method,path,body', [
    ('PUT', '/api/speech/voiceprint/settings', {'enabled': False, 'scope': 'calls'}),
    ('POST', '/api/speech/voiceprint/enroll', {'audio': 'AAE='}),
    ('POST', '/api/speech/voiceprint/test', {'audio': 'AAE='}),
    ('POST', '/api/speech/voiceprint/download', None),
    ('POST', '/api/speech/voiceprint/cancel', None),
    ('DELETE', '/api/speech/voiceprint/download', None),
    ('DELETE', '/api/speech/voiceprint', None),
])
async def test_voiceprint_management_is_host_scoped_without_retired_capabilities(
        tmp_path, monkeypatch, project_access, method, path, body):
    import main
    from types import SimpleNamespace
    from services.gateway_client.policy import ManagedPolicyCache
    from services.remote_access import ActorSnapshot, actor_context
    monkeypatch.setattr(main, 'gateway_client', SimpleNamespace(managed_config=object(), policy_cache=ManagedPolicyCache()))
    service = SpeechService(tmp_path, MODEL_ID)
    monkeypatch.setattr(speech, 'service', service)
    calls = []
    async def operation(*args):
        calls.append(args)
        return 'matched'
    for name in ('configure', 'enroll', 'verify', 'download', 'cancel_download', 'delete'):
        monkeypatch.setattr(service.voiceprint, name, operation)
    app = FastAPI(); app.include_router(speech.router)
    actor = ActorSnapshot('user', 'User', 'device', 'Device', 'managed',
        project_id='p' if project_access else None, access_level=project_access)
    with actor_context(actor):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
            response = await client.request(method, path, **({'json': body} if body else {}))
    assert response.status_code == (403 if project_access else 200), response.text
    assert bool(calls) == (project_access is None)


@pytest.mark.asyncio
async def test_call_scope_and_storage_canary(tmp_path, monkeypatch):
    service = SpeechService(tmp_path, MODEL_ID)
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    monkeypatch.setattr(service.voiceprint, 'available', lambda: True)
    async def extract(pcm):
        return {'embedding': [1., 0., 0.], 'voiced_samples': 96000}
    monkeypatch.setattr(service.voiceprint, 'extract', extract)
    original_write = service.voiceprint._write
    def slow_write(profile):
        time.sleep(.12)
        original_write(profile)
    monkeypatch.setattr(service.voiceprint, '_write', slow_write)
    pending = asyncio.create_task(service.voiceprint.enroll(b'\x01\x02' * 96000))
    await asyncio.sleep(.02)
    assert not pending.done(), 'slow disk must run off the event loop'
    await pending
    await service.voiceprint.configure(True, 'calls')
    plain = (await service.start('p', 'owner'))['id']
    assert service.sessions[plain]['voiceprint'] is None
    call = (await service.start('p', 'owner', True))['id']
    assert service.sessions[call]['voiceprint']['enabled']
    await service.close()


@pytest.mark.asyncio
async def test_hash_or_load_failure_never_publishes_speaker_model(tmp_path, monkeypatch):
    service = VoiceprintService(tmp_path, lambda: tmp_path / 'runtime')
    async def broken(*args):
        raise ValueError('hash failure')
    monkeypatch.setattr(service.resources, 'fetch', broken)
    await service._download('https://mirror.example')
    assert service.install['stage'] == 'error'
    assert not service.available()
    assert not service.resources.stage.exists()
    assert not list(service.root.glob('*.onnx'))


@pytest.mark.asyncio
async def test_corrupt_profile_never_silently_disables_filter_and_can_be_deleted(tmp_path):
    service = VoiceprintService(tmp_path, lambda: tmp_path / 'runtime')
    service.root.mkdir()
    (service.root / 'profile.enc').write_bytes(b'corrupt')
    assert (await service.snapshot())['error'] == 'voiceprint.profileUnavailable'
    with pytest.raises(ValueError, match='profileUnavailable'):
        await service.profile()
    await service.delete()
    assert not (await service.snapshot())['enrolled']


@pytest.mark.asyncio
async def test_live_recording_rejects_profile_mutation_and_cancel_discards_pending_match(tmp_path, monkeypatch):
    service = SpeechService(tmp_path, MODEL_ID)
    service.settings = {'enabled': True, 'language': 'auto'}
    monkeypatch.setattr(service, 'installed', lambda: True)
    monkeypatch.setattr(service.voiceprint, 'available', lambda: True)
    async def profile():
        return {'enabled': True, 'scope': 'all', 'embedding': [1., 0., 0.]}
    monkeypatch.setattr(service.voiceprint, 'profile', profile)
    monkeypatch.setattr(speech, 'service', service)
    monkeypatch.setattr(speech, 'authorize', lambda *a, **kw: None)
    sid = (await service.start('p', 'owner'))['id']
    app = FastAPI(); app.include_router(speech.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
        assert (await client.delete('/api/speech/voiceprint')).status_code == 409
    entered, release = asyncio.Event(), asyncio.Event()
    async def verify(pcm, profile=None):
        entered.set()
        await release.wait()
        return 'matched'
    monkeypatch.setattr(service.voiceprint, 'verify', verify)
    request = asyncio.create_task(service.audio(sid, 'p', 'owner', 0, b'\x01\x02' * 32000, True))
    await entered.wait()
    await service.cancel(sid, 'p', 'owner')
    release.set()
    with pytest.raises(LookupError):
        await request
    await service.close()
