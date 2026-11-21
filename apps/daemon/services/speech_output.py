"""Host TTS configuration, bounded project-owned synthesis sessions and lifecycle."""
import asyncio
import base64
import hashlib
import io
import json
import os
import re
import time
import uuid
import wave
from contextlib import aclosing
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from cryptography.fernet import Fernet
from engines.core.process_cleanup import finish_cleanup

from services.config import CONFIG_DIR
from services import speech_profiles
from services.tts_catalog import DEFAULT_LOCAL_MODEL, DEFAULT_LOCAL_VOICE, LOCAL_MODELS, MODELS, OMNI_DESIGN_ATTRIBUTES, OMNI_PERSONA_VOICE, OMNI_TONES, PROVIDERS, voices
from services.tts_omni_persona import design_attributes, digital_delivery, prompted_tone, reference_tone, saved_persona_attributes
from services.tts_resources import TtsResources
from services.tts_runtime import TtsRuntime
from services.tts_remote import MAX_AUDIO, SpeechConfigurationError, remote_audio, speech_failure_code

SECRET_FIELDS = speech_profiles.SECRET_FIELDS
MAX_REFERENCE_BYTES = 12 * 1024 * 1024
LOCAL_DELIVERY_MODELS = frozenset(('cosyvoice3', 'omnivoice'))
DEFAULTS = dict(mode='system', provider='qwen', model_id=DEFAULT_LOCAL_MODEL, model='qwen3-tts-flash-realtime',
    base_url='', voice='Cherry', rate=1.0, volume=1.0, instructions='', region='beijing',
    resource_id='seed-tts-2.0', app_id='', engine='qwen', api_key='', secret_id='', secret_key='',
    reference_id='', reference_text='')


def reference_path(root, identifier):
    return root / 'references' / f'{identifier}.wav'


def reference_entry(path):
    if path.is_symlink() or not re.fullmatch(r'[0-9a-f]{64}', path.stem):
        return None
    try:
        modified = path.stat().st_mtime
        with wave.open(str(path), 'rb') as audio:
            duration = audio.getnframes() / audio.getframerate()
    except (OSError, ValueError, wave.Error, EOFError):
        return None
    return {'id': path.stem, 'modified': modified, 'duration': duration}


def list_references(root):
    rows = filter(None, (reference_entry(path) for path in (root / 'references').glob('*.wav')))
    return sorted(rows, key=lambda row: (row['modified'], row['id']), reverse=True)


def store_reference(root, content):
    if not content or len(content) > MAX_REFERENCE_BYTES:
        raise ValueError('Reference audio must be a WAV of at most 12 MiB')
    try:
        with wave.open(io.BytesIO(content), 'rb') as audio:
            frames, channels, width, rate = (audio.getnframes(), audio.getnchannels(),
                                             audio.getsampwidth(), audio.getframerate())
            if (channels not in (1, 2) or width != 2 or not 8000 <= rate <= 96000
                    or not rate / 2 <= frames <= rate * 30
                    or len(audio.readframes(frames)) != frames * channels * width):
                raise ValueError('Select a 0.5–30 second mono or stereo 16-bit PCM WAV')
    except (wave.Error, EOFError) as exc:
        raise ValueError('Reference audio must be a valid PCM WAV') from exc
    identifier = hashlib.sha256(content).hexdigest()
    target = reference_path(root, identifier)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if target.is_file() and not target.is_symlink() and target.stat().st_size == len(content) and target.read_bytes() == content:
        return identifier
    stage = target.parent / ('.reference-' + uuid.uuid4().hex)
    try:
        fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
        stage.replace(target)
    finally:
        stage.unlink(missing_ok=True)
    return identifier


def validate(value):
    result = {**DEFAULTS, **{k: v for k, v in value.items() if k in DEFAULTS}}
    if result['mode'] not in ('system', 'local', 'cloud', 'remote'):
        raise ValueError('Unsupported speech output method')
    if result['provider'] not in {p['id'] for p in PROVIDERS}:
        raise ValueError('Unsupported voice service provider')
    if result['mode'] == 'cloud' and result['provider'] not in ('qwen', 'tencent', 'volcengine', 'openai'):
        raise ValueError('Please select a cloud voice service provider')
    if result['mode'] == 'remote' and result['provider'] not in ('openai', 'voicebox'):
        raise ValueError('Please select the remote voice protocol')
    for name in DEFAULTS:
        if name in ('rate', 'volume'):
            continue
        item = result[name]
        if name in SECRET_FIELDS and item is None:
            continue
        if not isinstance(item, str) or len(item) > (4096 if name in SECRET_FIELDS else 2000):
            raise ValueError('Invalid voice setting format')
        if '\0' in item or name != 'instructions' and any(c in item for c in '\r\n'):
            raise ValueError('Voice settings cannot contain newlines or control characters')
        result[name] = item.strip()
    for name, lo, hi in [('rate', .5, 2), ('volume', 0, 1)]:
        if isinstance(result[name], bool) or not isinstance(result[name], (int, float)) or not lo <= result[name] <= hi:
            raise ValueError('Speech rate or volume out of range')
    if result['model_id'] not in MODELS:
        raise ValueError('Unsupported voice output model')
    if result['mode'] != 'system' and not result['voice']:
        raise ValueError('Please select or enter a voice')
    if result['mode'] in ('cloud', 'remote'):
        if result['provider'] == 'tencent' and not result['voice'].isdigit():
            raise ValueError('Tencent Cloud voice ID must be a number')
        if result['provider'] == 'qwen' and result['region'] not in ('beijing', 'singapore'):
            raise ValueError('Unsupported Qwen region')
        if result['provider'] == 'volcengine' and not result['resource_id']:
            raise ValueError('Please enter the Volcano Engine resource ID')
        if result['provider'] not in ('tencent', 'volcengine') and not result['model']:
            raise ValueError('Please fill in the voice model')
    if result['mode'] == 'local':
        spec = MODELS[result['model_id']]
        allowed = {v['id'] for v in voices(result['model_id'])} if result['model_id'] in LOCAL_MODELS or spec['runtime'] == 'qwen' else {
            str(i) for i in range(spec['speakers'])}
        if result['voice'] not in allowed:
            raise ValueError('Please select a voice supported by the chosen model')
        if spec['voice_design'] and not result['instructions']:
            raise ValueError('Please provide a voice description')
        if result['instructions'] and not spec['instructions']:
            raise ValueError('The selected model does not support tone instructions')
        if spec.get('style') == 'tone' and result['instructions'] and result['instructions'] not in OMNI_TONES:
            if result['voice'] != 'reference' or reference_tone(result['instructions']) is None:
                raise ValueError('OmniVoice 提示词需包含自然、温柔、低沉、明快、俏皮或耳语等可识别的语气。')
        if result['model_id'] in LOCAL_MODELS and result['voice'] == 'reference' and not result['reference_id']:
            raise ValueError('Upload reference audio first')
    if result['reference_id'] and not re.fullmatch('[0-9a-f]{64}', result['reference_id']):
        raise ValueError('Invalid reference audio ID')
    if result['mode'] == 'remote' or result['provider'] == 'openai' and result['mode'] == 'cloud':
        if not result['base_url'] and result['mode'] == 'cloud':
            result['base_url'] = 'https://api.openai.com/v1'
        url = urlsplit(result['base_url'])
        try:
            port = url.port
        except ValueError as exc:
            raise ValueError('Invalid service address port') from exc
        if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
                or url.query or url.fragment or port == 0):
            raise ValueError('Please provide a valid HTTP service address. Use the secret field for credentials.')
        result['base_url'] = result['base_url'].rstrip('/')
    return result


class SpeechOutputService:
    def __init__(self, root=None):
        self.root = Path(root) if root else CONFIG_DIR / 'speech-output'
        self.resources = TtsResources(self.root / 'models')
        self.runtime = TtsRuntime()
        self.lock = asyncio.Lock()
        self.cache = None
        self.profiles = []
        self.sessions = {}
        self.reaper = None

    def _read(self):
        try:
            result = json.loads((self.root / 'settings.json').read_text())
            profiles = result.pop('connections', [])
            result, *profiles = speech_profiles.decrypt([result, *profiles], self.root / 'vault.key')
            if result.get('model_id') in MODELS and result['model_id'] not in LOCAL_MODELS:
                result.update(model_id=DEFAULT_LOCAL_MODEL)
                if result.get('mode') == 'local':
                    result.update(voice=DEFAULT_LOCAL_VOICE, instructions='')
            settings = validate(result)
            return settings, speech_profiles.remember(profiles, settings)
        except FileNotFoundError:
            return dict(DEFAULTS), []

    async def _load(self):
        if self.cache is None:
            self.cache, self.profiles = await asyncio.to_thread(self._read)

    async def settings(self):
        async with self.lock:
            await self._load()
            return dict(self.cache)

    public = staticmethod(speech_profiles.public)

    async def resolve(self, value):
        async with self.lock:
            await self._load()
            return self._resolve(value)

    def _resolve(self, value):
        result = validate(value)
        previous = speech_profiles.find(self.profiles, result)
        for key in SECRET_FIELDS:
            if value.get(key) is None:
                result[key] = previous.get(key, '')
        return result

    async def configure(self, value):
        async with self.lock:
            return await finish_cleanup(self._configure(value))

    async def _configure(self, value):
        await self._load()
        result = self._resolve(value)
        if self.sessions:
            raise ValueError('Please stop voice playback before modifying the configuration')
        if result['mode'] == 'local' and result['model_id'] in LOCAL_MODELS and result['voice'] == 'reference':
            if not await asyncio.to_thread(reference_path(self.root, result['reference_id']).is_file):
                raise ValueError('Upload the reference audio again')
        profiles = speech_profiles.remember(self.profiles, result)
        await asyncio.to_thread(self._save, {**result, 'connections': profiles})
        self.cache, self.profiles = result, profiles
        await self.runtime.close()
        return self.public(result)

    async def connection_secret(self, target, field):
        async with self.lock:
            await self._load()
            return speech_profiles.find(self.profiles, {**DEFAULTS, **target}).get(field, '')

    async def upload_reference(self, content):
        async with self.lock:
            return await finish_cleanup(asyncio.to_thread(store_reference, self.root, content))

    async def reference_info(self, identifier):
        return await asyncio.to_thread(reference_entry, reference_path(self.root, identifier))

    async def delete_reference(self, identifier):
        if not re.fullmatch(r'[0-9a-f]{64}', identifier):
            raise ValueError('Invalid reference audio ID')
        async with self.lock:
            return await finish_cleanup(self._delete_reference(identifier))

    async def _delete_reference(self, identifier):
        await self._load()
        if self.sessions:
            raise ValueError('Please stop voice playback before deleting reference audio')

        def clear_reference(settings):
            if settings.get('reference_id') != identifier:
                return settings
            result = {**settings, 'reference_id': '', 'reference_text': ''}
            if result['mode'] == 'local' and result['voice'] == 'reference':
                result.update(voice=voices(result['model_id'])[0]['id'], instructions='')
            return result

        settings = clear_reference(self.cache)
        profiles = [clear_reference(row) for row in self.profiles]
        if settings != self.cache or profiles != self.profiles:
            # Publish the fallback first so a failed unlink cannot leave a dangling setting.
            await asyncio.to_thread(self._save, {**settings, 'connections': profiles})
            self.cache, self.profiles = settings, profiles
        await asyncio.to_thread(reference_path(self.root, identifier).unlink, missing_ok=True)
        return self.public(self.cache)

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
        active = dict(settings)
        profiles = active.pop('connections')
        data, *connections = speech_profiles.encrypt([active, *profiles], cipher)
        data['connections'] = connections
        stage = self.root / ('.settings-' + uuid.uuid4().hex)
        try:
            fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as file:
                json.dump(data, file)
            stage.replace(self.root / 'settings.json')
        finally:
            stage.unlink(missing_ok=True)

    async def snapshot(self, *, include_references=True):
        async with self.lock:
            await self._load()
            settings = self.public(self.cache)
            connections = [self.public(row) for row in self.profiles]
        def catalog():
            return [dict(id=key, name=value['name'], model_bytes=value['model_bytes'],
                installed=self.resources.installed(key), voices=voices(key), streaming='sentence',
                runtime=value['runtime'], instructions=value['instructions'], voice_design=value['voice_design'],
                **({'design_attributes': OMNI_DESIGN_ATTRIBUTES} if key == 'omnivoice' else {}),
                style=value.get('style', ''), availability_error=self.resources.platform_error(key),
                runtime_missing=bool(self.resources.runtime_error(key)),
                persona_runtime_missing=key == 'omnivoice' and not self.resources.omni_design_ready(),
                requirements=value['requirements'],
                license_url=f"https://huggingface.co/{value['repo']}",
                install=self.resources.install_status(key))
                for key, value in MODELS.items() if key in LOCAL_MODELS]
        result = dict(settings=settings, connections=connections, models=await asyncio.to_thread(catalog), providers=PROVIDERS,
                      service='busy' if self.sessions else 'ready' if self.runtime.process else 'stopped')
        if include_references:
            result['references'] = await asyncio.to_thread(list_references, self.root)
        return result

    async def model_action(self, action, model_id=None, mirror=None):
        async with self.lock:
            if self.sessions:
                raise ValueError('Please stop voice playback before managing the model')
            if action == 'cancel':
                await self.resources.cancel()
            elif action == 'unload':
                await self.runtime.close()
            else:
                self.resources.path(model_id)
                if action != 'discard':
                    await self.runtime.close()
                if action == 'download':
                    await self.resources.download(model_id, mirror)
                else:
                    await self.resources.delete(model_id, partial_only=action == 'discard')

    async def remote_voices(self, value):
        # Listing voices precedes choosing one; this value is never synthesized.
        settings = await self.resolve({**value, 'voice': value.get('voice') or '_discover'})
        if settings['mode'] != 'remote' or settings['provider'] != 'voicebox':
            raise ValueError('The current API only supports reading Voicebox voice profiles')
        headers = {'Authorization': 'Bearer ' + settings['api_key']} if settings['api_key'] else {}
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                response = await client.get(settings['base_url'] + '/profiles', headers=headers)
                response.raise_for_status()
                data = response.json()
                rows = data if isinstance(data, list) else data['profiles']
                return [dict(id=str(row['id']), name=str(row['name'])) for row in rows[:500]]
        except Exception as exc:
            raise ValueError('Unable to read Voicebox timbre, please check address, authentication, and service status:') from exc

    async def start(self, project, owner, text, draft=None, *, settings_snapshot=None, preview_prompt='', digital_person_id=None):
        if not text.strip() or len(text) > 1200:
            raise ValueError('Please enter a reading text of 1 to 1200 characters')
        settings = settings_snapshot
        if settings is None:
            settings = await self.resolve(draft) if draft is not None else await self.settings()
        adaptive = settings['mode'] == 'local' and settings['model_id'] in LOCAL_DELIVERY_MODELS
        if preview_prompt and (draft is None or not adaptive):
            raise ValueError('试听语气提示词仅适用于 CosyVoice3 或 OmniVoice 的设置试听。')
        if adaptive and draft is not None:
            # Host audition uses the model/default speaker or the selected recording.
            # Instructions from older clients remain compatible if supplied in the draft.
            prompt = preview_prompt or settings['instructions']
            if settings['model_id'] == 'omnivoice' and settings['voice'] == OMNI_PERSONA_VOICE:
                prompt = design_attributes(prompt, text)
            elif settings['model_id'] == 'omnivoice':
                if prompt.startswith('attributes:'):
                    prompt = design_attributes(prompt.removeprefix('attributes:'), text, cloning=True)
                    settings = {**settings, '_clone_attributes': bool(prompt)}
                else:
                    tone = prompt if prompt in OMNI_TONES else reference_tone(prompt) or prompted_tone(prompt)
                    if prompt and tone is None:
                        raise ValueError('OmniVoice 提示词需包含自然、温柔、低沉、明快、俏皮或耳语等可识别的语气。')
                    prompt = tone or ''
            settings = {**settings, 'instructions': prompt, '_resolved_delivery': True}
        elif adaptive and digital_person_id is not None:
            instructions, rate = await asyncio.to_thread(digital_delivery, settings['model_id'], settings['voice'], digital_person_id)
            settings = {**settings, 'instructions': instructions, '_resolved_delivery': True, '_delivery_rate': rate}
        async with self.lock:
            if len(self.sessions) >= 4:
                raise ValueError('Voice output concurrency has reached the limit, please try again later')
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
                raise SpeechConfigurationError('Please download the speech output model first')
            persona = settings['model_id'] == 'omnivoice' and settings['voice'] == OMNI_PERSONA_VOICE
            clone_attributes = bool(settings.get('_clone_attributes'))
            instructions = settings['instructions']
            if persona or clone_attributes:
                if not await asyncio.to_thread(self.resources.omni_design_ready):
                    raise SpeechConfigurationError('Install the OmniVoice voice design runtime first')
                if persona and not settings.get('_resolved_delivery'):
                    instructions = await asyncio.to_thread(saved_persona_attributes, instructions)
            else:
                runtime_error = await asyncio.to_thread(self.resources.runtime_error, settings['model_id'])
                if runtime_error:
                    raise SpeechConfigurationError(runtime_error)
            options = {}
            if settings['model_id'] in LOCAL_MODELS and settings['voice'] == 'reference':
                ref = reference_path(self.root, settings['reference_id'])
                if not await asyncio.to_thread(ref.is_file):
                    raise SpeechConfigurationError('Upload the reference audio again')
                options.update(reference=ref, reference_text=settings['reference_text'])
                if clone_attributes:
                    options['use_design'] = True
                elif settings['model_id'] == 'omnivoice':
                    instructions = reference_tone(instructions) or instructions
            async with aclosing(self.runtime.audio(self.resources.path(settings['model_id']), text, settings['voice'],
                                                  instructions, **options)) as stream:
                async for event in stream:
                    if settings.get('_delivery_rate', 1) != 1:
                        event = {**event, 'rate_factor': settings['_delivery_rate']}
                    yield event
        elif settings['mode'] in ('cloud', 'remote'):
            async with aclosing(remote_audio(settings, text)) as stream:
                async for event in stream:
                    yield event
        else:
            raise SpeechConfigurationError('System voice should be played by the client')

    async def _pump(self, session, settings, text):
        count = 0
        try:
            async with asyncio.timeout(360 if settings['mode'] == 'local' and MODELS[settings['model_id']]['runtime'] == 'qwen' else 120):
                async with aclosing(self._audio(settings, text)) as stream:
                    async for event in stream:
                        raw = base64.b64decode(event['audio'], validate=True)
                        count += len(raw)
                        wav = event['format'] == 'wav' and event['sample_rate'] in (24000, 48000)
                        pcm = event['format'] == 'pcm' and event['sample_rate'] == 24000
                        if count > MAX_AUDIO or not (wav or pcm):
                            raise ValueError('Invalid audio format or size')
                        if raw:
                            await session['queue'].put({**event, 'done': False})
            if not count:
                raise ValueError('Voice service did not return audio')
            await session['queue'].put({'done': True})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            code = speech_failure_code(exc)
            if settings['mode'] == 'local' and code == 'temporary':
                code = 'synthesis'
            message = {
                'temporary': '语音服务连接暂时不可用，请重试',
                'authentication': '语音服务认证失败，请检查密钥与权限',
                'configuration': '语音服务拒绝了配置，请检查模型、音色、连接与凭证',
                'synthesis': '语音合成失败，请检查语音设置',
            }[code]
            await session['queue'].put({'done': True, 'error': message, 'error_code': code})

    def _session(self, sid, project, owner):
        session = self.sessions.get(sid)
        if not session or session['project'] != project or session['owner'] != owner:
            raise LookupError('Voice playback has ended or access is not authorized')
        return session

    async def next(self, sid, project, owner):
        session = self._session(sid, project, owner)
        if session['read_lock'].locked():
            raise ValueError('Do not overlap-read the audio stream')
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
