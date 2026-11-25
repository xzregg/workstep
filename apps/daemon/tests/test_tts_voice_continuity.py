from types import SimpleNamespace

import base64
import json

import httpx
import pytest

from services.tts_local_worker import OmniVoiceSpeaker


def test_omni_segments_and_later_requests_reuse_one_designed_speaker():
    calls, encoded, seeds = [], [], []

    class Audio:
        def reshape(self, *args): return self
        def __getitem__(self, key): return self

    def generate(**options):
        calls.append(options)
        yield SimpleNamespace(audio=Audio())

    def encode(audio):
        tokens = object()
        encoded.append(tokens)
        return [tokens]

    mx = SimpleNamespace(random=SimpleNamespace(seed=seeds.append),
                         concatenate=lambda parts: list(parts)[0], eval=lambda value: None)
    model = SimpleNamespace(generate=generate, audio_tokenizer=SimpleNamespace(encode=encode))
    speaker = OmniVoiceSpeaker(model, mx)
    text = '第一句话。接下来继续保持同一个声音。' * 12
    request = dict(text=text, voice='persona', instructions='female, young adult')
    list(speaker.generate(request))
    assert len(encoded) == 1
    assert ''.join(call['text'] for call in calls[1:]) == text
    assert all(call['ref_tokens'] is encoded[0] for call in calls[1:])
    count = len(calls)
    list(speaker.generate({**request, 'text': '另一条回复也沿用这位说话人。'}))
    assert len(calls) == count + 1
    assert calls[-1]['ref_tokens'] is encoded[0]
    list(speaker.generate({**request, 'instructions': 'male, middle-aged'}))
    assert len(encoded) == 2 and calls[-1]['ref_tokens'] is encoded[1]


def test_omni_explicit_reference_is_never_replaced_by_a_designed_voice():
    calls = []

    def generate(**options):
        calls.append(options)
        yield SimpleNamespace(audio='audio')

    speaker = OmniVoiceSpeaker(SimpleNamespace(generate=generate),
                               SimpleNamespace(random=SimpleNamespace(seed=lambda value: None)))
    request = dict(text='参考音频保持原样。', voice='reference', instructions='low pitch',
                   reference='/private/reference.wav', reference_text='原始说话人。')
    list(speaker.generate(request))
    assert len(calls) == 1
    assert calls[0]['ref_audio'] == request['reference']
    assert calls[0]['ref_text'] == request['reference_text']
    assert 'ref_tokens' not in calls[0]


@pytest.mark.asyncio
@pytest.mark.parametrize('provider', ['openai', 'voicebox', 'volcengine', 'tencent'])
async def test_remote_complete_reading_keeps_text_and_voice_across_required_parts(provider, monkeypatch):
    from services import tts_remote
    from services.speech_output import DEFAULTS
    calls = []
    actual = httpx.AsyncClient
    text = '这是一段完整的回复。希望整段声音都保持自然、清晰。' * 10
    settings = {**DEFAULTS, 'provider': provider, 'voice': '101001', 'base_url': 'http://voice.test/v1',
                'secret_id': 'test', 'secret_key': 'test', 'api_key': 'test', 'model': 'test'}

    def handle(request):
        body = json.loads(request.content)
        calls.append(body)
        if provider == 'tencent':
            return httpx.Response(200, json={'Response': {'Audio': base64.b64encode(b'\0\0').decode()}})
        if provider == 'voicebox':
            return httpx.Response(200, content=b'RIFF' + b'\0' * 40)
        if provider == 'volcengine':
            return httpx.Response(200, content=b'{"code":0,"data":"AAAA"}\n{"code":20000000}\n')
        return httpx.Response(200, content=b'\0\0')

    monkeypatch.setattr(tts_remote.httpx, 'AsyncClient', lambda **kwargs: actual(transport=httpx.MockTransport(handle), **kwargs))
    assert [event async for event in tts_remote.remote_audio(settings, text)]
    if provider == 'tencent':
        assert ''.join(call['Text'] for call in calls) == text
        assert all(len(call['Text']) <= 150 and call['VoiceType'] == 101001 for call in calls)
    else:
        assert len(calls) == 1
        body = calls[0]
        if provider == 'volcengine': body = body['req_params']
        assert body.get('text', body.get('input')) == text
        assert body.get('speaker', body.get('profile_id', body.get('voice'))) == '101001'
