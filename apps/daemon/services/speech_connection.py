"""Host speech-input connection settings; credentials never leave the host."""
import json
import os
import re
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.fernet import Fernet

SECRETS = ('api_key', 'secret_id', 'secret_key')
DEFAULTS = dict(mode='local', provider='tencent', base_url='', model='16k_zh',
                resource_id='volc.seedasr.sauc.duration', app_id='', api_key='', secret_id='', secret_key='')
PROVIDERS = [dict(id='tencent', name='腾讯云', model='16k_zh', base_url='', streaming='native'),
             dict(id='volcengine', name='火山引擎', model='bigmodel', base_url='', streaming='native'),
             dict(id='openai', name='OpenAI compatible', model='gpt-transcribe',
                  base_url='https://api.openai.com/v1', streaming='final')]


def validate(value, current=None):
    result = {**DEFAULTS, **{k: v for k, v in value.items() if k in DEFAULTS}}
    if result['mode'] not in ('local', 'cloud', 'remote') or result['provider'] not in ('tencent', 'volcengine', 'openai'):
        raise ValueError('不支持的语音识别接入方式')
    if result['mode'] == 'remote' and result['provider'] != 'openai':
        raise ValueError('自建识别服务请选择 OpenAI 兼容协议')
    for key, item in result.items():
        if key in SECRETS and item is None:
            continue
        if not isinstance(item, str) or len(item) > (4096 if key in SECRETS else 2000) or any(c in item for c in '\0\r\n'):
            raise ValueError('语音识别连接配置格式无效')
        result[key] = item.strip()
        if key == 'base_url':
            result[key] = result[key].rstrip('/')
    same = current and all(result[k] == current.get(k) for k in ('mode', 'provider', 'base_url', 'app_id'))
    for key in SECRETS:
        if value.get(key) is None:
            result[key] = current.get(key, '') if same else ''
    if result['mode'] != 'local':
        if not result['model']:
            raise ValueError('请填写识别模型')
        if result['provider'] == 'openai':
            url = urlsplit(result['base_url'])
            try:
                port = url.port
            except ValueError as exc:
                raise ValueError('识别服务地址端口无效') from exc
            if (url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password
                    or url.query or url.fragment or port == 0):
                raise ValueError('请填写有效的 HTTP(S) 地址，密钥请单独填写')
            result['base_url'] = result['base_url'].rstrip('/')
        if result['mode'] == 'cloud':
            if result['provider'] == 'tencent':
                if not result['app_id'].isdigit() or not result['secret_id'] or not result['secret_key']:
                    raise ValueError('请填写腾讯云 AppID、SecretId 和 SecretKey')
                if not re.fullmatch(r'(16k_[A-Za-z0-9_-]+|Hy-ASR-3\.0-preview)', result['model']):
                    raise ValueError('请选择支持 16k PCM 的腾讯云识别引擎')
            elif not result['api_key']:
                raise ValueError('请填写语音识别 API Key')
            if result['provider'] == 'volcengine' and not result['resource_id']:
                raise ValueError('请填写火山引擎资源 ID')
            if result['provider'] == 'volcengine' and result['model'] != 'bigmodel':
                raise ValueError('火山实时识别模型应为 bigmodel')
    return result


def public(value):
    return {k: v for k, v in value.items() if k not in SECRETS} | {'has_' + k: bool(value.get(k)) for k in SECRETS}


def read(root):
    root = Path(root)
    try:
        value = json.loads((root / 'settings.json').read_text())
    except (OSError, ValueError):
        return {}
    connection = {**DEFAULTS, **value.get('connection', {})}
    if any(connection.get(k) for k in SECRETS):
        cipher = Fernet((root / 'vault.key').read_bytes())
        for key in SECRETS:
            connection[key] = cipher.decrypt(connection[key].encode()).decode() if connection.get(key) else ''
    value['connection'] = connection
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
    connection = dict(value['connection'])
    for key in SECRETS:
        connection[key] = cipher.encrypt(connection[key].encode()).decode() if connection.get(key) else ''
    stage = root / ('.settings-' + uuid.uuid4().hex)
    try:
        fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as file:
            json.dump({**value, 'connection': connection}, file)
        stage.replace(root / 'settings.json')
    finally:
        stage.unlink(missing_ok=True)
