"""Per-recording cloud WebSockets or bounded OpenAI-compatible WAV transcription."""
import asyncio
import base64
import gzip
import hashlib
import hmac
import io
import json
import secrets
import struct
import time
from urllib.parse import urlencode
import uuid
import wave
import zlib

import httpx
import websockets

MAX_RESPONSE = 4 * 1024 * 1024


def tencent_url(settings):
    now = int(time.time())
    params = dict(engine_model_type=settings['model'], expired=now + 300, timestamp=now,
                  nonce=secrets.randbelow(10**9), secretid=settings['secret_id'],
                  voice_id=uuid.uuid4().hex, voice_format=1, needvad=1)
    path = 'asr.cloud.tencent.com/asr/v2/' + settings['app_id']
    original = path + '?' + '&'.join(f'{k}={v}' for k, v in sorted(params.items()))
    signature = base64.b64encode(hmac.new(settings['secret_key'].encode(), original.encode(), hashlib.sha1).digest()).decode()
    return 'wss://' + path + '?' + urlencode({**params, 'signature': signature})


def volc_frame(payload, sequence, config=False, final=False):
    payload = gzip.compress(payload)
    flags = 3 if final else 1
    return (bytes([0x11, (0x10 if config else 0x20) | flags, 0x11 if config else 0x01, 0])
            + struct.pack('>iI', -sequence if final else sequence, len(payload)) + payload)


def volc_response(data):
    if not isinstance(data, bytes) or len(data) < 8:
        raise ValueError('云识别响应格式错误')
    flags, kind = data[1] & 15, data[1] >> 4
    offset = (data[0] & 15) * 4
    if flags & 1: offset += 4
    if flags & 4: offset += 4
    if kind == 15:
        raise ValueError('云识别返回错误')
    if kind != 9 or len(data) < offset + 4:
        raise ValueError('云识别响应格式错误')
    size = struct.unpack('>I', data[offset:offset + 4])[0]
    payload = data[offset + 4:]
    if len(payload) != size or size > MAX_RESPONSE:
        raise ValueError('云识别响应过大或不完整')
    if data[2] & 15 == 1:
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        payload = decoder.decompress(payload, MAX_RESPONSE + 1)
        if len(payload) > MAX_RESPONSE or decoder.unconsumed_tail or not decoder.eof:
            raise ValueError('云识别响应过大或不完整')
    return json.loads(payload), bool(flags & 2)


class RemoteSpeechRuntime:
    remote = True
    process = None

    def __init__(self, settings):
        self.settings = dict(settings)
        self.session_id = None
        self.last_used = time.monotonic()
        self.socket = None
        self.reader = None
        self.done = asyncio.Event()
        self.changed = asyncio.Event()
        self.error = None
        self.text = ''
        self.parts = {}
        self.pcm = bytearray()
        self.sequence = 1
        self.sent = 0
        self.started = None
        self.client = None
        self.operation = None
        self.closed = False

    async def _connect(self):
        if self.socket:
            return
        if self.settings['provider'] == 'tencent':
            url, headers = tencent_url(self.settings), {}
        else:
            url = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
            headers = {'X-Api-Key': self.settings['api_key'], 'X-Api-Resource-Id': self.settings['resource_id'],
                       'X-Api-Request-Id': uuid.uuid4().hex}
        self.socket = await websockets.connect(url, additional_headers=headers, open_timeout=8,
            close_timeout=2, max_size=MAX_RESPONSE, ping_interval=20)
        if self.settings['provider'] == 'tencent':
            event = json.loads(await asyncio.wait_for(self.socket.recv(), 8))
            if event.get('code') != 0:
                raise ValueError('云识别认证失败')
        else:
            config = dict(user=dict(uid=uuid.uuid4().hex), audio=dict(format='pcm', rate=16000, bits=16, channel=1),
                          request=dict(model_name='bigmodel', enable_itn=True, enable_punc=True, result_type='full'))
            await self.socket.send(volc_frame(json.dumps(config).encode(), self.sequence, config=True))
            self.sequence += 1
            first, _ = volc_response(await asyncio.wait_for(self.socket.recv(), 8))
            self._update(first, False)
        self.started = time.monotonic()
        self.reader = asyncio.create_task(self._read())

    def _update(self, event, final):
        if event.get('code', 0) not in (0, 1000):
            raise ValueError('云识别返回错误')
        result = event.get('result', {})
        if self.settings['provider'] == 'tencent':
            if 'voice_text_str' in result:
                self.parts[int(result['index'])] = result['voice_text_str']
                self.text = ''.join(self.parts[i] for i in sorted(self.parts))
            final = bool(event.get('final'))
        elif isinstance(result, dict) and 'text' in result:
            self.text = result['text']
        if not isinstance(self.text, str) or len(self.text) > 100000:
            raise ValueError('云识别文本格式无效')
        self.changed.set()
        if final:
            self.done.set()

    async def _read(self):
        try:
            async for message in self.socket:
                event, final = ((json.loads(message), False) if self.settings['provider'] == 'tencent' else volc_response(message))
                self._update(event, final)
                if self.done.is_set():
                    return
            if not self.done.is_set():
                raise ValueError('云识别连接提前关闭')
        except asyncio.CancelledError:
            raise
        except Exception:
            self.error = ValueError('云识别失败，请检查连接、模型和认证配置')
            self.done.set(); self.changed.set()

    async def infer(self, pcm, final):
        if self.closed:
            raise LookupError('录音已结束')
        self.operation = asyncio.create_task(self._infer(pcm, final))
        try:
            return await self.operation
        except asyncio.CancelledError:
            if self.closed:
                raise LookupError('录音已结束') from None
            raise
        finally:
            self.operation = None

    async def _infer(self, pcm, final):
        try:
            async with asyncio.timeout(18):
                if self.settings['provider'] == 'openai':
                    return await self._transcribe(pcm, final)
                await self._connect()
                self.changed.clear()
                chunks = [pcm[i:i + 6400] for i in range(0, len(pcm), 6400)] or ([b''] if final else [])
                for i, chunk in enumerate(chunks):
                    # Anchor pacing to the connection clock; delayed HTTP batches
                    # must not burst audio faster than the cloud's real-time rate.
                    await asyncio.sleep(max(0, self.sent / 32000 - (time.monotonic() - self.started)))
                    last = final and i == len(chunks) - 1
                    await self.socket.send(chunk if self.settings['provider'] == 'tencent' else
                        volc_frame(chunk, self.sequence, final=last))
                    self.sequence += 1
                    self.sent += len(chunk)
                if final:
                    if self.settings['provider'] == 'tencent':
                        await self.socket.send('{"type":"end"}')
                    await asyncio.wait_for(self.done.wait(), 10)
                else:
                    try:
                        await asyncio.wait_for(self.changed.wait(), .15)
                    except TimeoutError:
                        pass
                if self.error:
                    raise self.error
                return self.text
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise ValueError('云端或远程识别失败，请检查服务地址、模型和认证配置') from exc
        finally:
            self.last_used = time.monotonic()

    async def _transcribe(self, pcm, final):
        if len(self.pcm) + len(pcm) > 16000 * 2 * 120:
            raise ValueError('录音超过限制')
        self.pcm.extend(pcm)
        if not final or not self.pcm:
            return self.text
        # WAV packaging stays in memory and is isolated from the event loop.
        pcm = bytes(self.pcm)
        def package():
            output = io.BytesIO()
            with wave.open(output, 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(pcm)
            return output.getvalue()
        audio = await asyncio.to_thread(package)
        headers = {'Authorization': 'Bearer ' + self.settings['api_key']} if self.settings['api_key'] else {}
        self.client = httpx.AsyncClient(timeout=15, follow_redirects=False)
        async with self.client.stream('POST', self.settings['base_url'] + '/audio/transcriptions', headers=headers,
                data={'model': self.settings['model'], 'response_format': 'json'},
                files={'file': ('recording.wav', audio, 'audio/wav')}) as response:
            response.raise_for_status()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > MAX_RESPONSE:
                    raise ValueError('识别响应过大')
            text = json.loads(data)['text']
            if not isinstance(text, str) or len(text) > 100000:
                raise ValueError('识别结果格式无效')
            return text

    async def close(self):
        self.closed = True
        if self.operation:
            self.operation.cancel()
            await asyncio.gather(self.operation, return_exceptions=True)
        self.done.set(); self.changed.set()
        if self.reader:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
            self.reader = None
        if self.socket:
            await self.socket.close()
            self.socket = None
        if self.client:
            await self.client.aclose()
            self.client = None
        self.pcm.clear()
