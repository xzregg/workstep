import asyncio
import base64
import io
import json
import time
import wave

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
async def test_settings_encrypt_credentials_and_preserve_only_same_destination(output, monkeypatch):
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
    await reloaded.configure(dict(mode='system'))
    assert 'private-key' not in (output.root / 'settings.json').read_text()
    monkeypatch.setattr(speech_output, 'service', SpeechOutputService(output.root))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        status = (await client.get('/api/speech-output')).json()
        assert 'private-key' not in json.dumps(status)
        assert any(c['provider'] == 'qwen' and c['has_api_key'] for c in status['connections'])
        assert 'connections' not in (await client.get('/api/speech-output?project_id=p')).json()
        result = await client.post('/api/speech-output/settings/secret', json={**settings, 'field': 'api_key'})
        assert result.json() == {'value': 'private-key'}
        assert result.headers['cache-control'] == 'no-store'
        assert (await client.put('/api/speech-output/settings', json={**settings, 'api_key': None})).json()['has_api_key']
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
@pytest.mark.parametrize(('failure', 'code'), [
    (httpx.ConnectError('private endpoint'), 'temporary'),
    (503, 'temporary'), (401, 'authentication'), (403, 'authentication'), (400, 'configuration'),
    (RuntimeError('private endpoint'), 'synthesis'),
])
async def test_synthesis_failure_has_safe_stable_code(output, monkeypatch, failure, code):
    async def broken(settings, text):
        if isinstance(failure, int):
            request = httpx.Request('POST', 'https://example.com/private-endpoint')
            httpx.Response(failure, request=request).raise_for_status()
        raise failure
        yield

    monkeypatch.setattr(output, '_audio', broken)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        created = await client.post('/api/speech-output/sessions', json={
            'text': '你好', 'settings': {'mode': 'cloud', 'provider': 'qwen', 'api_key': 'private-key'},
        })
        sid = created.json()['id']
        result = (await client.post(f'/api/speech-output/sessions/{sid}/next')).json()
        assert result['done'] and result['error_code'] == code
        assert 'private' not in result['error']
        assert (await client.delete(f'/api/speech-output/sessions/{sid}')).status_code == 200


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
        assert (await client.post('/api/speech-output/settings/secret',
                                  json=dict(mode='cloud', provider='qwen', field='api_key'))).status_code == 403
        assert (await client.post('/api/speech-output/models/download?model_id=kokoro-v1')).status_code == 403
        assert (await client.post('/api/speech-output/models/discard?model_id=kokoro-v1')).status_code == 403
        assert (await client.post('/api/speech-output/reference', content=b'wav')).status_code == 403
        assert (await client.delete(f'/api/speech-output/reference/{"a" * 64}')).status_code == 403
        assert (await client.post('/api/speech-output/sessions?project_id=p', json={
            'text': '你好。', 'digital_session_id': 'known',
        })).status_code == 403
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
async def test_cosyvoice_preview_prompt_is_separate_from_persona_playback(output, monkeypatch):
    from services import tts_omni_persona
    from services.digital_person import DigitalPersonProfile

    def load_profile():
        time.sleep(.15)
        return DigitalPersonProfile(role='学习陪练', tone='温柔自然', personality='喜欢用简短句子')

    monkeypatch.setattr(tts_omni_persona, 'get_profile', load_profile)
    monkeypatch.setattr(output.resources, 'installed', lambda model_id: True)
    monkeypatch.setattr(output.resources, 'runtime_error', lambda model_id: '')
    calls = []

    async def audio(path, text, voice, instructions, **options):
        calls.append(instructions)
        yield {'audio': 'AAAA', 'format': 'pcm', 'sample_rate': 24000}

    monkeypatch.setattr(output.runtime, 'audio', audio)
    draft = dict(mode='local', model_id='cosyvoice3', voice='default', instructions='尽量放慢语速。')
    try:
        await output.configure(draft)
        for settings in (draft, None):
            sid = (await output.start('', 'local', '晚上好。', settings,
                                      preview_prompt='活泼地说' if settings is not None else '',
                                      digital_person_id='' if settings is None else None))['id']
            assert (await output.next(sid, '', 'local'))['audio']
            await output.cancel(sid, '', 'local')
        assert calls[0] == '活泼地说'
        assert calls[1].startswith('温柔自然\n喜欢用简短句子\n')
        pending = asyncio.create_task(output.start('', 'local', '晚上好。', {**draft, 'instructions': ''}))
        await asyncio.sleep(.02)
        assert not pending.done()
        sid = (await pending)['id']
        assert (await output.next(sid, '', 'local'))['audio']
        await output.cancel(sid, '', 'local')
        assert calls[2] == '学习陪练\n喜欢用简短句子\n温柔自然'
    finally:
        await output.close()


@pytest.mark.asyncio
async def test_save_stops_own_host_audition_but_preserves_other_playback(output, monkeypatch):
    rendering = asyncio.Event()
    stopped = asyncio.Event()

    async def render(*args):
        try:
            rendering.set()
            await asyncio.Future()
            yield {}
        finally:
            stopped.set()

    monkeypatch.setattr(output, '_audio', render)
    settings = dict(mode='local', model_id='omnivoice', voice='persona', instructions='attributes:male')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        try:
            preview = (await client.post('/api/speech-output/sessions',
                                         json={'text': '试听。', 'settings': settings})).json()['id']
            await asyncio.wait_for(rendering.wait(), 1)
            other = (await output.start('', 'other-device', 'Another preview.', settings))['id']
            playback = (await output.start('project', 'local', 'Formal playback.'))['id']
            assert (await client.put('/api/speech-output/settings', json=settings)).status_code == 409
            assert {preview, other, playback} <= output.sessions.keys()
            await output.cancel(other, '', 'other-device')
            await output.cancel(playback, 'project', 'local')

            response = await client.put('/api/speech-output/settings', json=settings)
            assert response.is_success
            assert response.json()['instructions'] == settings['instructions']
            assert stopped.is_set() and not output.sessions
        finally:
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
    async def start(path, design=False):
        code = ("import sys,json,time;sys.stdin.readline();"
                "print(json.dumps({'audio':'AAAA'*30000,'format':'pcm','sample_rate':24000}),flush=True);time.sleep(60)")
        output.runtime.process = await asyncio.create_subprocess_exec(sys.executable, '-c', code,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        output.runtime.model = (path, design)
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
    monkeypatch.setitem(tts_resources.MODELS['kokoro-v1'], 'files', [('model.onnx', 4, '0' * 64, 'sha256')])
    def handler(request):
        assert request.url.host == 'huggingface.co'
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
async def test_local_catalog_exposes_three_models_and_validates_model_controls(output):
    from services.speech_output import validate
    status = await output.snapshot()
    catalog = {m['id']: m for m in status['models']}
    assert set(catalog) == {'moss-nano', 'cosyvoice3', 'omnivoice'}
    assert len(catalog['moss-nano']['voices']) == 19
    assert catalog['cosyvoice3']['style'] == 'instruction'
    assert catalog['omnivoice']['style'] == 'tone'
    assert [voice['id'] for voice in catalog['omnivoice']['voices']] == ['persona', 'reference']
    validate(dict(mode='local', model_id='moss-nano', voice='Xiaoyu'))
    with pytest.raises(ValueError):
        validate(dict(mode='local', model_id='omnivoice', voice='reference', instructions='自由描述'))
    from services.tts_catalog import MODELS, voices
    small = MODELS['qwen-06-custom']
    assert small['runtime'] == 'qwen' and not small['instructions']
    assert any(v['id'] == 'Vivian' for v in voices('qwen-06-custom'))
    assert MODELS['qwen-17-custom']['instructions']
    assert MODELS['qwen-17-design']['voice_design']
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
async def test_omnivoice_default_voice_uses_only_saved_tags(output, monkeypatch):
    from services import tts_omni_persona

    def load_profile():
        pytest.fail('OmniVoice must not load digital-person voice prompts')

    def no_swift(model_id):
        raise AssertionError('Persona synthesis does not use the Swift reference runtime')

    calls = []

    async def audio(path, text, voice, instructions, **options):
        calls.append((path.name, text, voice, instructions, options))
        yield {'audio': 'AAAA', 'format': 'pcm', 'sample_rate': 24000}

    monkeypatch.setattr(tts_omni_persona, 'get_profile', load_profile)
    monkeypatch.setattr(output.resources, 'installed', lambda model_id: True)
    monkeypatch.setattr(output.resources, 'omni_design_ready', lambda: True)
    monkeypatch.setattr(output.resources, 'runtime_error', no_swift)
    monkeypatch.setattr(output.runtime, 'audio', audio)
    settings = {'mode': 'local', 'model_id': 'omnivoice', 'voice': 'persona'}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        async def play(body, project=''):
            query = f'?project_id={project}'
            response = await client.post(f'/api/speech-output/sessions{query}', json=body)
            assert response.status_code == 200
            sid = response.json()['id']
            path = f'/api/speech-output/sessions/{sid}'
            assert (await client.post(f'{path}/next{query}')).json()['audio']
            assert (await client.post(f'{path}/next{query}')).json() == {'done': True}
            assert (await client.delete(f'{path}{query}')).status_code == 200

        for prompt in ('温柔、沉稳', 'attributes:male'):
            rejected = await client.post('/api/speech-output/sessions', json={
                'text': '今晚慢慢来。', 'settings': settings, 'preview_prompt': prompt,
            })
            assert rejected.status_code == 409
        await play({'text': '今晚慢慢来。', 'settings': settings})
        await play({'text': 'Good evening.', 'settings': {
            **settings, 'instructions': 'attributes:high pitch, british accent',
        }})
        assert (await output.settings())['mode'] == 'system'
        assert (await client.put('/api/speech-output/settings', json=settings)).status_code == 200
        await play({'text': '我来陪你。'}, 'digital-person-project')
        await play({'text': '晚上好。', 'settings': {**settings, 'instructions': 'whisper'}})

    assert calls == [
        ('omnivoice', '今晚慢慢来。', 'persona', 'female, young adult', {}),
        ('omnivoice', 'Good evening.', 'persona', 'female, young adult, high pitch, british accent', {}),
        ('omnivoice', '我来陪你。', 'persona', 'female, young adult', {}),
        ('omnivoice', '晚上好。', 'persona', 'female, young adult, whisper', {}),
    ]
    await output.close()


@pytest.mark.asyncio
async def test_omnivoice_saved_tags_drive_preview_and_playback(output, monkeypatch):
    from services import tts_omni_persona
    from services.digital_person import DigitalPersonProfile

    monkeypatch.setattr(tts_omni_persona, 'get_profile', lambda: DigitalPersonProfile(personality='年轻女声'))
    monkeypatch.setattr(output.resources, 'installed', lambda model_id: True)
    monkeypatch.setattr(output.resources, 'omni_design_ready', lambda: True)
    calls = []

    async def audio(path, text, voice, instructions, **options):
        calls.append((voice, instructions, options.get('use_design', False)))
        yield {'audio': 'AAAA', 'format': 'pcm', 'sample_rate': 24000}

    monkeypatch.setattr(output.runtime, 'audio', audio)
    settings = dict(mode='local', model_id='omnivoice', voice='persona', instructions='attributes:male, elderly, british accent')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        assert (await client.put('/api/speech-output/settings', json=settings)).is_success
        assert (await client.get('/api/speech-output')).json()['settings']['instructions'] == settings['instructions']
        for invalid in ('attributes:male, female', 'attributes:用温柔的语气说', '温柔'):
            assert (await client.put('/api/speech-output/settings',
                                     json={**settings, 'instructions': invalid})).status_code == 409

    async def play(text, draft=None, digital_person_id=None):
        sid = (await output.start('', 'local', text, draft, digital_person_id=digital_person_id))['id']
        assert (await output.next(sid, '', 'local'))['audio']
        await output.cancel(sid, '', 'local')

    try:
        await play('Good evening.', settings)
        await play('晚上好。', digital_person_id='')
        wav = io.BytesIO()
        with wave.open(wav, 'wb') as reference:
            reference.setparams((1, 2, 24000, 0, 'NONE', ''))
            reference.writeframes(b'\0\0' * 24000)
        identifier = await output.upload_reference(wav.getvalue())
        await output.configure({**settings, 'voice': 'reference', 'reference_id': identifier,
                                'instructions': 'attributes:low pitch, whisper'})
        await play('晚安。', digital_person_id='')
        assert calls == [
            ('persona', 'male, elderly, british accent', False),
            ('persona', 'male, elderly', False),
            ('reference', 'low pitch, whisper', True),
        ]
    finally:
        await output.close()


@pytest.mark.asyncio
async def test_omnivoice_reference_playback_keeps_saved_tone_without_preview_leak(output, monkeypatch):
    from api import digital_person
    from services import digital_person_affect, digital_person_sessions, tts_omni_persona

    def unexpected_profile_read(*_):
        pytest.fail('OmniVoice must not use digital-person traits or affinity')

    monkeypatch.setattr(tts_omni_persona, 'get_profile', unexpected_profile_read)
    monkeypatch.setattr(digital_person, 'runtime', lambda: object())
    monkeypatch.setattr(output.resources, 'installed', lambda model_id: True)
    monkeypatch.setattr(output.resources, 'runtime_error', lambda model_id: '')
    monkeypatch.setattr(output.resources, 'omni_design_ready', lambda: True)
    calls = []

    async def subject(_, project, session):
        assert (project, session) == ('p', 'chat')
        return 'matched-person'

    async def audio(path, text, voice, instructions, **options):
        calls.append((voice, instructions, options))
        yield {'audio': 'AAAA', 'format': 'pcm', 'sample_rate': 24000}

    monkeypatch.setattr(digital_person_sessions, 'affect_person', subject)
    monkeypatch.setattr(digital_person_affect, 'read', unexpected_profile_read)
    monkeypatch.setattr(output.runtime, 'audio', audio)
    wav = io.BytesIO()
    with wave.open(wav, 'wb') as reference:
        reference.setparams((1, 2, 24000, 0, 'NONE', ''))
        reference.writeframes(b'\0\0' * 24000)
    identifier = await output.upload_reference(wav.getvalue())
    reference_path = output.root / 'references' / f'{identifier}.wav'
    settings = dict(mode='local', model_id='omnivoice', voice='reference', reference_id=identifier, instructions='happy', rate=1.2)
    await output.configure(settings)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        combo = (await client.post('/api/speech-output/sessions', json={
            'text': '晚安。', 'settings': {**settings, 'instructions': 'attributes:low pitch, whisper'},
        })).json()['id']
        assert (await client.post(f'/api/speech-output/sessions/{combo}/next')).json()['audio']
        assert (await client.post(f'/api/speech-output/sessions/{combo}/next')).json()['done']
        await client.delete(f'/api/speech-output/sessions/{combo}')
        formal = (await client.post('/api/speech-output/sessions?project_id=p',
            json={'text': '晚上好。', 'digital_session_id': 'chat'})).json()['id']
        chunk = (await client.post(f'/api/speech-output/sessions/{formal}/next?project_id=p')).json()
        assert chunk['audio'] and 'rate_factor' not in chunk
        assert (await client.post(f'/api/speech-output/sessions/{formal}/next?project_id=p')).json()['done']
        await client.delete(f'/api/speech-output/sessions/{formal}?project_id=p')

    assert [(voice, prompt, options['reference']) for voice, prompt, options in calls] == [
        ('reference', 'low pitch, whisper', reference_path),
        ('reference', 'happy', reference_path),
    ]
    assert calls[0][2]['use_design'] is True
    assert (await output.settings())['instructions'] == 'happy'
    assert (await output.settings())['rate'] == 1.2
    await output.close()


@pytest.mark.asyncio
async def test_reference_upload_and_validation_leave_health_responsive(output, monkeypatch):
    from services import speech_output as implementation
    original = implementation.store_reference

    def slow_store(root, content):
        time.sleep(.15)
        return original(root, content)

    monkeypatch.setattr(implementation, 'store_reference', slow_store)
    target = io.BytesIO()
    with wave.open(target, 'wb') as wav:
        wav.setparams((1, 2, 24000, 0, 'NONE', ''))
        wav.writeframes(b'\x00\x00' * 24000)
    wav_data = target.getvalue()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
        pending = asyncio.create_task(client.post('/api/speech-output/reference', content=wav_data))
        await asyncio.sleep(.02)
        assert (await asyncio.wait_for(client.get('/health'), .10)).status_code == 200
        assert not pending.done()
        response = await pending
        assert response.status_code == 200
        reference = response.json()['id']
        assert response.json()['reference']['duration'] == 1.0
        host = (await client.get('/api/speech-output')).json()
        assert host['references'] == [response.json()['reference']]
        scoped = (await client.get('/api/speech-output?project_id=p')).json()
        assert 'references' not in scoped
        assert (output.root / 'references' / f'{reference}.wav').read_bytes() == wav_data
        settings = dict(mode='local', model_id='omnivoice', voice='reference', instructions='warm')
        assert (await client.put('/api/speech-output/settings', json=settings)).status_code == 409
        assert (await client.put('/api/speech-output/settings', json={**settings, 'reference_id': reference})).status_code == 200
        custom = {**settings, 'reference_id': reference, 'instructions': 'prompt:用温柔、沉稳的语气说。'}
        assert (await client.put('/api/speech-output/settings', json=custom)).status_code == 409
        assert (await output.settings())['instructions'] == 'warm'
        output._save({**custom, 'connections': []})
        loaded = await SpeechOutputService(output.root).settings()
        assert loaded['instructions'] == '' and loaded['reference_id'] == reference
        assert (await client.put('/api/speech-output/settings', json={**settings, 'voice': 'persona'})).status_code == 200
        assert (await client.get('/api/speech-output')).json()['references'] == host['references']
        assert (await client.put('/api/speech-output/settings', json={**settings, 'reference_id': reference})).status_code == 200
        other = (await client.post('/api/speech-output/reference', content=wav_data[:-2] + b'\1\0')).json()['id']
        assert (await client.delete('/api/speech-output/reference/not-a-hash')).status_code == 409
        deleted = await client.delete(f'/api/speech-output/reference/{reference}')
        assert deleted.status_code == 200
        assert deleted.json()['settings']['voice'] == 'persona'
        assert deleted.json()['settings']['reference_id'] == ''
        assert deleted.json()['settings']['reference_text'] == ''
        assert deleted.json()['settings']['instructions'] == ''
        assert not (output.root / 'references' / f'{reference}.wav').exists()
        assert [row['id'] for row in (await client.get('/api/speech-output')).json()['references']] == [other]
        assert (await SpeechOutputService(output.root).settings())['voice'] == 'persona'
        assert (await client.delete(f'/api/speech-output/reference/{reference}')).status_code == 200
        assert (await client.post('/api/speech-output/reference', content=wav_data[:-2])).status_code == 409
    await output.close()


def test_local_catalog_resolves_companion_assets_on_selected_hugging_face_origin():
    from services.tts_catalog import file_source
    assert file_source('moss-nano', 'MOSS-Audio-Tokenizer-Nano-ONNX/codec_browser_onnx_meta.json') == (
        'OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX', 'ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae',
        'codec_browser_onnx_meta.json')
    assert file_source('cosyvoice3', 'speech_tokenizer/model.safetensors') == (
        'mlx-community/S3TokenizerV3', 'b143914b3e912278104824da706edc9c2d317c4e', 'model.safetensors')


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
    spec = tts_resources.MODELS['qwen-06-custom']
    monkeypatch.setitem(spec, 'files', [(name, len(data), hashlib.sha256(data).hexdigest(), 'sha256')
                                       for name, data in files.items()])
    def handler(request):
        assert request.url.host == 'mirror.example'
        assert request.url.path.startswith(f"/hub/{spec['repo']}/resolve/{spec['revision']}/")
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
    await output.resources.download('qwen-06-custom', 'https://mirror.example/hub/')
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
    with pytest.raises(ValueError, match='校验失败|Component validation failed'):
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
