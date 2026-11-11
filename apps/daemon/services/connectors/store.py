"""Local encrypted connector definitions; every caller performs I/O off-loop."""
import copy
import json
import os
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from pydantic import BaseModel, ConfigDict, Field, field_validator

from services.config import CONFIG_DIR


class ConnectorDefinition(BaseModel):
    model_config = ConfigDict(extra='ignore')
    id: str = ''
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default='', max_length=1000)
    kind: str = 'mcp'
    transport: str = 'stdio'
    command: str = Field(default='', max_length=4096)
    args: list[str] = Field(default_factory=list, max_length=100)
    url: str = Field(default='', max_length=8192)
    headers: dict[str, str] = Field(default_factory=dict)
    env: dict[str, str] = Field(default_factory=dict)
    project_ids: list[str] = Field(default_factory=list, max_length=1000)
    enabled: bool = True
    revision: int = 0

    @field_validator('name')
    @classmethod
    def name_not_blank(cls, value):
        if not value.strip():
            raise ValueError('名称不能为空')
        return value.strip()

    def validate_connection(self):
        if self.kind not in {'mcp', 'cli'} or self.transport not in {'stdio', 'http', 'sse'}:
            raise ValueError('不支持的连接类型')
        if self.kind == 'cli' or self.transport == 'stdio':
            if not self.command.strip() or '\x00' in self.command:
                raise ValueError('请填写可执行命令')
        else:
            url = urlsplit(self.url)
            if url.username or url.password or url.scheme not in {'https', 'http'} or not url.hostname:
                raise ValueError('请填写有效的 HTTP MCP 地址，凭据请使用请求头字段')
            if url.scheme == 'http' and url.hostname not in {'localhost', '127.0.0.1', '::1'}:
                raise ValueError('远程连接必须使用 HTTPS')
        if any('\n' in key or '\r' in key or '\n' in value or '\r' in value for key, value in self.headers.items()):
            raise ValueError('请求头不能包含换行')


class ConnectorStore:
    def __init__(self, directory: Path):
        self.directory = directory
        self._lock = threading.RLock()

    def _vault(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        key_file = self.directory / 'vault.key'
        if not key_file.exists():
            try:
                fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(fd, 'wb') as file:
                    file.write(Fernet.generate_key())
        return Fernet(key_file.read_bytes())

    def _read(self):
        file = self.directory / 'definitions.enc'
        if not file.exists():
            return {'items': [], 'sessions': {}}
        return json.loads(self._vault().decrypt(file.read_bytes()))

    def _write(self, data):
        vault = self._vault()
        file = self.directory / f'.{uuid.uuid4().hex}.tmp'
        try:
            fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as out:
                out.write(vault.encrypt(json.dumps(data, ensure_ascii=False).encode()))
            os.replace(file, self.directory / 'definitions.enc')
        finally:
            file.unlink(missing_ok=True)

    @staticmethod
    def public(item):
        result = {k: copy.deepcopy(v) for k, v in item.items() if k not in {'headers', 'env'}}
        result.update(has_credentials=bool(item.get('headers') or item.get('env')),
                      header_names=list(item.get('headers', {})), env_names=list(item.get('env', {})))
        return result

    @staticmethod
    def allowed(item, project_id):
        return bool(item.get('enabled', True) and (not item.get('project_ids') or project_id in item['project_ids']))

    def list(self):
        with self._lock:
            return [self.public(item) for item in self._read()['items']]

    def resolve(self, identifier):
        with self._lock:
            return copy.deepcopy(next((item for item in self._read()['items'] if item['id'] == identifier), None))

    def preview(self, value):
        """Validate a draft, retaining saved secrets without persisting changes."""
        with self._lock:
            previous = next((i for i in self._read()['items'] if i['id'] == value.get('id')), None)
            if value.get('id') and (previous is None or value.get('revision') != previous['revision']):
                raise ValueError('配置已更新，请刷新后重试')
            item = ConnectorDefinition.model_validate({**(previous or {}), **value})
            item.validate_connection()
            if previous and item.url != previous.get('url') and 'headers' not in value and previous.get('headers'):
                raise ValueError('地址变化后请重新填写认证信息')
            return item.model_dump()

    def save(self, value):
        with self._lock:
            data = self._read()
            previous = next((i for i in data['items'] if i['id'] == value.get('id')), None)
            if value.get('id') and previous is None:
                raise ValueError('连接器不存在')
            if previous and value.get('revision') != previous['revision']:
                raise ValueError('配置已更新，请刷新后重试')
            merged = {**(previous or {}), **value}
            item = ConnectorDefinition.model_validate(merged)
            item.validate_connection()
            item.id = previous['id'] if previous else uuid.uuid4().hex
            item.revision = (previous or {}).get('revision', 0) + 1
            item.project_ids = list(dict.fromkeys(item.project_ids))
            document = item.model_dump()
            data['items'] = [i for i in data['items'] if i['id'] != item.id] + [document]
            self._write(data)
            return self.public(document)

    def delete(self, identifier):
        with self._lock:
            data = self._read()
            data['items'] = [i for i in data['items'] if i['id'] != identifier]
            data['sessions'] = {key: [i for i in ids if i != identifier] for key, ids in data['sessions'].items()}
            self._write(data)

    def select(self, project_id, session_id, identifiers):
        if not project_id or not session_id or len(session_id) > 256:
            raise ValueError('请选择项目和会话')
        with self._lock:
            data = self._read()
            for identifier in identifiers:
                item = next((i for i in data['items'] if i['id'] == identifier), None)
                if item is None or not self.allowed(item, project_id):
                    raise PermissionError('连接器不在当前项目可用范围内')
            data['sessions'][json.dumps([project_id, session_id])] = list(dict.fromkeys(identifiers))
            self._write(data)

    def selected(self, project_id, session_id):
        with self._lock:
            data = self._read()
            ids = data['sessions'].get(json.dumps([project_id, session_id]), [])
            return [copy.deepcopy(item) for item in data['items'] if item['id'] in ids and self.allowed(item, project_id)]


connector_store = ConnectorStore(CONFIG_DIR / 'connectors')
