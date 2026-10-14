"""Device-local selections; packages and creation sessions remain shared."""

import hashlib
import json
import tempfile
import threading
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class AppearanceSelection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    skin_id: str = Field(default='default', pattern=r'^[a-z][a-z0-9_-]{0,63}$')
    language: str = Field(default='zh-CN', pattern=r'^(?:zh-CN|zh-TW|en-US|ja-JP|pack:[a-z][a-z0-9_-]{0,63})$')
    font_family: Literal['system', 'pingfang', 'serif'] = 'system'
    font_size: Literal['small', 'standard', 'large', 'extraLarge'] = 'standard'


class AppearancePatch(AppearanceSelection):
    """Only explicitly supplied fields are merged into the saved selection."""


def identity_scope(gateway_id: str, device_id: str, user_id: str) -> str:
    identity = json.dumps([gateway_id, device_id, user_id], separators=(',', ':'))
    return hashlib.sha256(identity.encode()).hexdigest()


class AppearancePreferences:
    # Each operation runs wholly in a worker, including the merge and rename.
    _lock = threading.RLock()

    def __init__(self, root: Path):
        self.root = root

    def read(self, scope: str) -> dict:
        with self._lock:
            try:
                value = json.loads((self.root / f'{scope}.json').read_text())
                return AppearanceSelection.model_validate(value).model_dump()
            except (FileNotFoundError, ValueError):
                return AppearanceSelection().model_dump()

    def update(self, scope: str, patch: dict) -> dict:
        with self._lock:
            value = AppearanceSelection.model_validate({**self.read(scope), **patch}).model_dump()
            self.root.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.root, delete=False) as file:
                    temporary = Path(file.name)
                    json.dump(value, file, ensure_ascii=False)
                temporary.replace(self.root / f'{scope}.json')
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            return value
