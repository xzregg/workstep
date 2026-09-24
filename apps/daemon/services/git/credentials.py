"""Persistent HTTPS credentials shared by Git repositories and worktrees."""

import json
import os
import tempfile

from .command import GitError


def load_credentials(path):
    try:
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(data, dict) or any(
            not isinstance(host, str) or not isinstance(value, dict)
            or not isinstance(value.get('username'), str)
            or not isinstance(value.get('token'), str)
            for host, value in data.items()
        ):
            raise ValueError('invalid credentials')
        return data
    except (OSError, ValueError) as exc:
        raise GitError('无法读取 Git 登录凭据文件。') from exc


def save_credentials(path, credentials):
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary = tempfile.mkstemp(prefix='.git-credentials-', dir=path.parent)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(credentials, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    except OSError as exc:
        raise GitError('无法保存 Git 登录凭据文件。') from exc
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
