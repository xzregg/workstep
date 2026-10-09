"""Private delegated credentials; permissions are always fetched afresh."""
import hashlib
import json
import os
import tempfile

from services import config as config_module


def _path(origin):
    return config_module.CONFIG_DIR / 'gateway-connections' / (hashlib.sha256(origin.encode()).hexdigest() + '.json')


def load(origin):
    path = _path(origin)
    if not path.exists():
        return None
    value = json.loads(path.read_text())
    return value if isinstance(value, dict) else None


def save(origin, value):
    path = _path(origin)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(value, file)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def delete(origin):
    _path(origin).unlink(missing_ok=True)
