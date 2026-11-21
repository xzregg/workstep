"""Encrypted storage and validation for host speech-input connections."""
import json
import os
import re
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from services import speech_profiles

SECRETS = speech_profiles.SECRET_FIELDS
DEFAULTS = dict(mode='local', provider='tencent', base_url='', model='16k_zh',
                resource_id='volc.seedasr.sauc.duration', app_id='', api_key='', secret_id='', secret_key='')
PROVIDERS = [dict(id='tencent', name='腾讯云', model='16k_zh', base_url='', streaming='native'),
             dict(id='volcengine', name='火山引擎', model='bigmodel', base_url='', streaming='native'),
             dict(id='openai', name='OpenAI compatible', model='gpt-transcribe',
                  base_url='https://api.openai.com/v1', streaming='final')]


def validate(value, profiles=()):
    result = {**DEFAULTS, **{k: v for k, v in value.items() if k in DEFAULTS}}
    if result['mode'] not in ('local', 'cloud', 'remote') or result['provider'] not in ('tencent', 'volcengine', 'openai'):
        raise ValueError('Unsupported speech recognition access method')
    if result['mode'] == 'remote' and result['provider'] != 'openai':
        raise ValueError('For self-hosted recognition services, please select the OpenAI-compatible protocol')
    for key, item in result.items():
        if key in SECRETS and item is None:
            continue
        if not isinstance(item, str) or len(item) > (4096 if key in SECRETS else 2000) or any(c in item for c in '\0\r\n'):
            raise ValueError('Invalid voice recognition connection configuration format')
        result[key] = item.strip()
        if key == 'base_url':
            result[key] = result[key].rstrip('/')
    previous = speech_profiles.find(profiles, result)
    for key in SECRETS:
        if value.get(key) is None:
            result[key] = previous.get(key, '')
    if result['mode'] != 'local':
        if not result['model']:
            raise ValueError('Please specify the recognition model')
        if result['provider'] == 'openai':
            url = urlsplit(result['base_url'])
            try:
                port = url.port
            except ValueError as exc:
                raise ValueError('Invalid service address port') from exc
            if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
                    or url.query or url.fragment or port == 0):
                raise ValueError('Please enter a valid HTTP(S) address, and enter the key separately')
            result['base_url'] = result['base_url'].rstrip('/')
        if result['mode'] == 'cloud':
            if result['provider'] == 'tencent':
                if not result['app_id'].isdigit() or not result['secret_id'] or not result['secret_key']:
                    raise ValueError('Please fill in the Tencent Cloud AppID, SecretId, and SecretKey')
                if not re.fullmatch(r'(16k_[A-Za-z0-9_-]+|Hy-ASR-3\.0-preview)', result['model']):
                    raise ValueError('Please select the Tencent Cloud recognition engine that supports 16k PCM')
            elif not result['api_key']:
                raise ValueError('Please enter the Speech Recognition API Key')
            if result['provider'] == 'volcengine' and not result['resource_id']:
                raise ValueError('Please enter the Volcano Engine resource ID')
            if result['provider'] == 'volcengine' and result['model'] != 'bigmodel':
                raise ValueError('The Volcano real-time recognition model should be bigmodel')
    return result


def read(root):
    root = Path(root)
    try:
        value = json.loads((root / 'settings.json').read_text())
    except (OSError, ValueError):
        return {}
    connection = {**DEFAULTS, **value.get('connection', {})}
    connection, *profiles = speech_profiles.decrypt(
        [connection, *value.get('connections', [])], root / 'vault.key')
    value['connection'] = connection
    value['connections'] = speech_profiles.remember(profiles, connection)
    return value


def save(root, value):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    key_path = root / 'vault.key'
    try:
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'wb') as file:
            file.write(Fernet.generate_key())
    cipher = Fernet(key_path.read_bytes())
    connection, *profiles = speech_profiles.encrypt([value['connection'], *value['connections']], cipher)
    stage = root / ('.settings-' + uuid.uuid4().hex)
    try:
        fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as file:
            json.dump({**value, 'connection': connection, 'connections': profiles}, file)
        stage.replace(root / 'settings.json')
    finally:
        stage.unlink(missing_ok=True)
