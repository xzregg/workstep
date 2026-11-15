"""Cloud protocols and explicit self-hosted endpoints. Secrets never reach clients."""
import base64
import datetime
import hashlib
import hmac
import json
import time
import uuid
from urllib.parse import urlencode

import httpx
import websockets

MAX_AUDIO = 24 * 1024 * 1024


def pcm(data):
    return dict(audio=base64.b64encode(data).decode(), format='pcm', sample_rate=24000)


def tencent_request(settings, text, timestamp=None):
    timestamp = timestamp or int(time.time())
    date = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime('%Y-%m-%d')
    body = json.dumps(dict(Text=text, SessionId=uuid.uuid4().hex, VoiceType=int(settings['voice']),
                           ModelType=1, Codec='pcm', SampleRate=24000), separators=(',', ':'), ensure_ascii=False).encode()
    canonical = ('POST\n/\n\ncontent-type:application/json; charset=utf-8\n'
                 'host:tts.tencentcloudapi.com\n\ncontent-type;host\n' + hashlib.sha256(body).hexdigest())
    scope = date + '/tts/tc3_request'
    message = f'TC3-HMAC-SHA256\n{timestamp}\n{scope}\n' + hashlib.sha256(canonical.encode()).hexdigest()
    def sign(key, value):
        return hmac.new(key, value.encode(), hashlib.sha256).digest()
    key = sign(sign(sign(('TC3' + settings['secret_key']).encode(), date), 'tts'), 'tc3_request')
    signature = hmac.new(key, message.encode(), hashlib.sha256).hexdigest()
    headers = {'Content-Type': 'application/json; charset=utf-8', 'Host': 'tts.tencentcloudapi.com',
        'X-TC-Action': 'TextToVoice', 'X-TC-Version': '2019-08-23', 'X-TC-Timestamp': str(timestamp),
        'X-TC-Region': settings['region'], 'Authorization':
        f"TC3-HMAC-SHA256 Credential={settings['secret_id']}/{scope}, SignedHeaders=content-type;host, Signature={signature}"}
    return headers, body


async def remote_audio(settings, text):
    provider = settings['provider']
    if provider == 'qwen':
        host = 'dashscope-intl.aliyuncs.com' if settings['region'] == 'singapore' else 'dashscope.aliyuncs.com'
        url = f'wss://{host}/api-ws/v1/realtime?' + urlencode({'model': settings['model']})
        async with websockets.connect(url, additional_headers={'Authorization': 'Bearer ' + settings['api_key']},
                                      open_timeout=20, max_size=MAX_AUDIO) as socket:
            async def send(kind, **values):
                await socket.send(json.dumps(dict(event_id=uuid.uuid4().hex, type=kind, **values)))
            # Wait for server configuration acknowledgement before sending text.
            async for message in socket:
                event = json.loads(message)
                kind = event.get('type')
                if kind == 'error':
                    raise ValueError('云语音服务拒绝了请求，请检查凭证、模型和音色')
                if kind == 'session.created':
                    config = dict(mode='commit', voice=settings['voice'], language_type='Auto',
                                  response_format='pcm', sample_rate=24000)
                    if settings['instructions'] and 'instruct' in settings['model']:
                        config['instructions'] = settings['instructions']
                        config['optimize_instructions'] = True
                    await send('session.update', session=config)
                elif kind == 'session.updated':
                    await send('input_text_buffer.append', text=text)
                    await send('input_text_buffer.commit')
                elif kind == 'response.audio.delta':
                    yield pcm(base64.b64decode(event['delta'], validate=True))
                elif kind == 'response.done':
                    await send('session.finish')
                    return
            raise ValueError('云语音连接提前结束')
        return

    async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
        if provider == 'tencent':
            # This API returns a complete sentence; do not claim audio streaming.
            for offset in range(0, len(text), 120):
                headers, body = tencent_request(settings, text[offset:offset + 120])
                response = await client.post('https://tts.tencentcloudapi.com', content=body, headers=headers)
                response.raise_for_status()
                result = response.json()['Response']
                if 'Error' in result:
                    raise ValueError('腾讯云语音请求失败，请检查凭证、权限和音色')
                yield pcm(base64.b64decode(result['Audio'], validate=True))
            return
        if provider == 'volcengine':
            headers = {'X-Api-Resource-Id': settings['resource_id'], 'X-Api-Request-Id': str(uuid.uuid4())}
            if settings['app_id']:
                headers.update({'X-Api-App-Id': settings['app_id'], 'X-Api-Access-Key': settings['api_key']})
            else:
                headers['X-Api-Key'] = settings['api_key']
            body = dict(user=dict(uid='workstep'), req_params=dict(text=text, speaker=settings['voice'],
                audio_params=dict(format='pcm', sample_rate=24000)))
            async with client.stream('POST', 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
                                     headers=headers, json=body) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    if event.get('code') not in (0, 20000000):
                        raise ValueError('火山语音请求失败，请检查凭证、资源 ID 和音色')
                    if event.get('data'):
                        yield pcm(base64.b64decode(event['data'], validate=True))
            return
        headers = {'Authorization': 'Bearer ' + settings['api_key']} if settings['api_key'] else {}
        if provider == 'voicebox':
            body = dict(profile_id=settings['voice'], text=text, engine=settings['engine'],
                        model_size=settings['model'], language='zh', personality=False)
            if settings['instructions']:
                body['instruct'] = settings['instructions']
            async with client.stream('POST', settings['base_url'] + '/generate/stream', headers=headers, json=body) as response:
                response.raise_for_status()
                data = bytearray()
                async for block in response.aiter_bytes():
                    data.extend(block)
                    if len(data) > MAX_AUDIO:
                        raise ValueError('返回音频过大')
                if not data.startswith(b'RIFF'):
                    raise ValueError('Voicebox 未返回 WAV 音频')
                yield dict(audio=base64.b64encode(data).decode(), format='wav', sample_rate=24000)
            return
        # OpenAI speech-compatible services return 24 kHz mono PCM when requested.
        body = dict(model=settings['model'], input=text, voice=settings['voice'], response_format='pcm')
        async with client.stream('POST', settings['base_url'] + '/audio/speech', headers=headers, json=body) as response:
            response.raise_for_status()
            total = 0
            async for block in response.aiter_bytes(16384):
                total += len(block)
                if total > MAX_AUDIO:
                    raise ValueError('返回音频过大')
                yield pcm(block)
