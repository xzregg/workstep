"""Host TTS configuration, bounded project-owned synthesis sessions and lifecycle."""
import asyncio
import base64
import json
import os
import time
import uuid
from contextlib import aclosing
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from cryptography.fernet import Fernet
from engines.core.process_cleanup import finish_cleanup

from services.config import CONFIG_DIR
from services.tts_catalog import MODELS, PROVIDERS, voices
from services.tts_resources import TtsResources
from services.tts_runtime import TtsRuntime
from services.tts_remote import MAX_AUDIO, remote_audio

SECRET_FIELDS = ('api_key', 'secret_id', 'secret_key')
DEFAULTS = dict(mode='system', provider='qwen', model_id='kokoro-v1', model='qwen3-tts-flash-realtime',
    base_url='', voice='Cherry', rate=1.0, volume=1.0, instructions='', region='beijing',
    resource_id='seed-tts-2.0', app_id='', engine='qwen', api_key='', secret_id='', secret_key='')


def validate(value):
    result = {**DEFAULTS, **{k: v for k, v in value.items() if k in DEFAULTS}}
    if result['mode'] not in ('system', 'local', 'cloud', 'remote'):
        raise ValueError('不支持的语音输出方式')
    if result['provider'] not in {p['id'] for p in PROVIDERS}:
        raise ValueError('不支持的语音服务商')
    if result['mode'] == 'cloud' and result['provider'] not in ('qwen', 'tencent', 'volcengine', 'openai'):
        raise ValueError('请选择云语音服务商')
    if result['mode'] == 'remote' and result['provider'] not in ('openai', 'voicebox'):
        raise ValueError('请选择远程语音协议')
    for name in DEFAULTS:
        if name in ('rate', 'volume'):
            continue
        item = result[name]
        if name in SECRET_FIELDS and item is None:
            continue
        if not isinstance(item, str) or len(item) > (4096 if name in SECRET_FIELDS else 2000):
            raise ValueError('语音设置格式无效')
        if '\0' in item or name != 'instructions' and any(c in item for c in '\r\n'):
            raise ValueError('语音设置不能包含换行或控制字符')
        result[name] = item.strip()
    for name, lo, hi in [('rate', .5, 2), ('volume', 0, 1)]:
        if isinstance(result[name], bool) or not isinstance(result[name], (int, float)) or not lo <= result[name] <= hi:
            raise ValueError('语速或音量超出范围')
    if result['model_id'] not in MODELS:
        raise ValueError('不支持的语音输出模型')
    if result['mode'] != 'system' and not result['voice']:
        raise ValueError('请选择或填写音色')
    if result['mode'] in ('cloud', 'remote'):
        if result['provider'] == 'tencent' and not result['voice'].isdigit():
            raise ValueError('腾讯云音色 ID 必须为数字')
        if result['provider'] == 'qwen' and result['region'] not in ('beijing', 'singapore'):
            raise ValueError('不支持的 Qwen 地域')
        if result['provider'] == 'volcengine' and not result['resource_id']:
            raise ValueError('请填写火山引擎资源 ID')
        if result['provider'] not in ('tencent', 'volcengine') and not result['model']:
            raise ValueError('请填写语音模型')
    if result['mode'] == 'local':
        spec = MODELS[result['model_id']]
        allowed = {v['id'] for v in voices(result['model_id'])} if spec['runtime'] == 'qwen' else {
            str(i) for i in range(spec['speakers'])}
        if result['voice'] not in allowed:
            raise ValueError('请选择所选模型支持的音色')
        if spec['voice_design'] and not result['instructions']:
            raise ValueError('请填写音色描述')
        if result['instructions'] and not spec['instructions']:
            raise ValueError('所选模型不支持语气指令')
    if result['mode'] == 'remote' or result['provider'] == 'openai' and result['mode'] == 'cloud':
        if not result['base_url'] and result['mode'] == 'cloud':
            result['base_url'] = 'https://api.openai.com/v1'
        url = urlsplit(result['base_url'])
        try:
            port = url.port
        except ValueError as exc:
            raise ValueError('服务地址端口无效') from exc
        if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
                or url.query or url.fragment or port == 0):
            raise ValueError('请填写有效的 HTTP 服务地址，凭证请使用密钥字段')
        result['base_url'] = result['base_url'].rstrip('/')
    return result


class SpeechOutputService:
    def __init__(self, root=None):
        self.root = Path(root) if root else CONFIG_DIR / 'speech-output'
        self.resources = TtsResources(self.root / 'models')
        self.runtime = TtsRuntime()
        self.lock = asyncio.Lock()
        self.cache = None
        self.sessions = {}
        self.reaper = None

    def _read(self):
        try:
            result = json.loads((self.root / 'settings.json').read_text())
            cipher = Fernet((self.root / 'vault.key').read_bytes()) if any(result.get(k) for k in SECRET_FIELDS) else None
            for key in SECRET_FIELDS:
                result[key] = cipher.decrypt(result[key].encode()).decode() if result.get(key) else ''
            return validate(result)
        except FileNotFoundError:
            return dict(DEFAULTS)

    async def settings(self):
        async with self.lock:
            if self.cache is None:
                self.cache = await asyncio.to_thread(self._read)
            return dict(self.cache)

    @staticmethod
    def public(settings):
        return {k: v for k, v in settings.items() if k not in SECRET_FIELDS} | {
            'has_' + k: bool(settings.get(k)) for k in SECRET_FIELDS}

    async def resolve(self, value):
        current = await self.settings()
        result = validate(value)
        same = all(result[k] == current[k] for k in ('mode', 'provider', 'base_url', 'region', 'app_id'))
        for key in SECRET_FIELDS:
            if value.get(key) is None:
                result[key] = current[key] if same else ''
        return result

    async def configure(self, value):
        result = await self.resolve(value)
        async with self.lock:
            if self.sessions:
                raise ValueError('请先停止语音播放再修改配置')
            await asyncio.to_thread(self._save, result)
            self.cache = result
        await self.runtime.close()
        return self.public(result)

    def _save(self, settings):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        key_path = self.root / 'vault.key'
        try:
            fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'wb') as file:
                file.write(Fernet.generate_key())
        cipher = Fernet(key_path.read_bytes())
        data = dict(settings)
        for key in SECRET_FIELDS:
            data[key] = cipher.encrypt(data[key].encode()).decode() if data[key] else ''
        stage = self.root / ('.settings-' + uuid.uuid4().hex)
        try:
            fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as file:
                json.dump(data, file)
            stage.replace(self.root / 'settings.json')
        finally:
            stage.unlink(missing_ok=True)

    async def snapshot(self):
        settings = await self.settings()
        def catalog():
            return [dict(id=key, name=value['name'], model_bytes=value['model_bytes'],
                installed=self.resources.installed(key), voices=voices(key), streaming='sentence',
                runtime=value['runtime'], instructions=value['instructions'], voice_design=value['voice_design'],
                requirements=value['requirements'],
                license_url=f"https://huggingface.co/{value['repo']}",
                install=self.resources.states.get(key, dict(stage='idle', downloaded_bytes=0, total_bytes=None, error='')))
                for key, value in MODELS.items()]
        return dict(settings=self.public(settings), models=await asyncio.to_thread(catalog), providers=PROVIDERS,
                    service='busy' if self.sessions else 'ready' if self.runtime.process else 'stopped')

    async def model_action(self, action, model_id=None):
        async with self.lock:
            if self.sessions:
                raise ValueError('请先停止语音播放再管理模型')
            if action == 'cancel':
                await self.resources.cancel()
            elif action == 'unload':
                await self.runtime.close()
            else:
                self.resources.path(model_id)
                await self.runtime.close()
                if action == 'download':
                    await self.resources.download(model_id)
                else:
                    await self.resources.delete(model_id)

    async def remote_voices(self, value):
        # Listing voices precedes choosing one; this value is never synthesized.
        settings = await self.resolve({**value, 'voice': value.get('voice') or '_discover'})
        if settings['mode'] != 'remote' or settings['provider'] != 'voicebox':
            raise ValueError('当前接口仅支持读取 Voicebox 音色档案')
        headers = {'Authorization': 'Bearer ' + settings['api_key']} if settings['api_key'] else {}
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                response = await client.get(settings['base_url'] + '/profiles', headers=headers)
                response.raise_for_status()
                data = response.json()
                rows = data if isinstance(data, list) else data['profiles']
                return [dict(id=str(row['id']), name=str(row['name'])) for row in rows[:500]]
        except Exception as exc:
            raise ValueError('无法读取 Voicebox 音色，请检查地址、认证和服务状态') from exc

    async def start(self, project, owner, text, draft=None):
        if not text.strip() or len(text) > 1200:
            raise ValueError('请输入 1 到 1200 字的朗读文本')
        settings = await self.resolve(draft) if draft is not None else await self.settings()
        async with self.lock:
            if len(self.sessions) >= 4:
                raise ValueError('语音输出并发已达上限，请稍后重试')
            sid = uuid.uuid4().hex
            session = dict(project=project, owner=owner, queue=asyncio.Queue(8),
                           touched=time.monotonic(), read_lock=asyncio.Lock())
            self.sessions[sid] = session
            session['task'] = asyncio.create_task(self._pump(session, settings, text))
            if not self.reaper or self.reaper.done():
                self.reaper = asyncio.create_task(self._reap())
            return {'id': sid}

    async def _audio(self, settings, text):
        if settings['mode'] == 'local':
            if not await asyncio.to_thread(self.resources.installed, settings['model_id']):
                raise ValueError('请先下载语音输出模型')
            async with aclosing(self.runtime.audio(self.resources.path(settings['model_id']), text, settings['voice'],
                                                  settings['instructions'])) as stream:
                async for event in stream:
                    yield event
        elif settings['mode'] in ('cloud', 'remote'):
            async with aclosing(remote_audio(settings, text)) as stream:
                async for event in stream:
                    yield event
        else:
            raise ValueError('系统语音请由客户端播放')

    async def _pump(self, session, settings, text):
        count = 0
        try:
            async with asyncio.timeout(360 if settings['mode'] == 'local' and MODELS[settings['model_id']]['runtime'] == 'qwen' else 120):
                async with aclosing(self._audio(settings, text)) as stream:
                    async for event in stream:
                        raw = base64.b64decode(event['audio'], validate=True)
                        count += len(raw)
                        if count > MAX_AUDIO or event['format'] not in ('pcm', 'wav') or event['sample_rate'] != 24000:
                            raise ValueError('音频格式或大小无效')
                        if raw:
                            await session['queue'].put({**event, 'done': False})
            if not count:
                raise ValueError('语音服务未返回音频')
            await session['queue'].put({'done': True})
        except asyncio.CancelledError:
            raise
        except Exception:
            await session['queue'].put({'done': True, 'error': '语音合成失败，请检查模型、音色、连接与认证配置'})

    def _session(self, sid, project, owner):
        session = self.sessions.get(sid)
        if not session or session['project'] != project or session['owner'] != owner:
            raise LookupError('语音播放已结束或无权访问')
        return session

    async def next(self, sid, project, owner):
        session = self._session(sid, project, owner)
        if session['read_lock'].locked():
            raise ValueError('请勿重叠读取语音流')
        async with session['read_lock']:
            session['touched'] = time.monotonic()
            try:
                result = await asyncio.wait_for(session['queue'].get(), 10)
            except TimeoutError:
                result = {'done': False}
            self._session(sid, project, owner)
            session['touched'] = time.monotonic()
            return result

    async def cancel(self, sid, project, owner):
        session = self._session(sid, project, owner)
        self.sessions.pop(sid, None)
        session['task'].cancel()
        await asyncio.gather(session['task'], return_exceptions=True)

    async def _reap(self):
        while True:
            await asyncio.sleep(10)
            for sid, session in list(self.sessions.items()):
                if time.monotonic() - session['touched'] > 30:
                    try:
                        await self.cancel(sid, session['project'], session['owner'])
                    except LookupError:
                        pass  # A concurrent client may already have cancelled it.
            if not self.sessions and time.monotonic() - self.runtime.last_used > 300:
                await self.runtime.close()
                return

    async def close(self):
        await finish_cleanup(self._close())

    async def _close(self):
        if self.reaper:
            self.reaper.cancel()
            await asyncio.gather(self.reaper, return_exceptions=True)
        for sid, session in list(self.sessions.items()):
            await self.cancel(sid, session['project'], session['owner'])
        await self.resources.cancel()
        await self.runtime.close()


service = SpeechOutputService()
