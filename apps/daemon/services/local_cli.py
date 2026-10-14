"""Per-launch, owner-private discovery for local CLI; never a remote login."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import tempfile
from urllib.parse import urlsplit

HEADER = 'X-WorkStep-CLI-Token'
LOOPBACK = {'127.0.0.1', '::1', 'localhost'}


def local_origin(url: str) -> str | None:
    try:
        value = urlsplit(url)
        if (value.scheme not in {'http', 'https'} or value.hostname not in LOOPBACK
                or value.username is not None or value.password is not None
                or value.path not in {'', '/'} or value.query or value.fragment):
            return None
        host = f'[{value.hostname}]' if value.hostname == '::1' else value.hostname
        return f'{value.scheme}://{host}:{value.port or (443 if value.scheme == "https" else 80)}'
    except ValueError:
        return None


def credential_path(url: str) -> Path:
    origin = local_origin(url)
    if origin is None:
        raise ValueError('CLI discovery requires a loopback daemon URL')
    root = Path(os.environ.get('WORKSTEP_CONFIG_DIR') or Path.home() / '.workstep')
    return root / 'cli-runtime' / f'cli-{hashlib.sha256(origin.encode()).hexdigest()[:24]}.json'


def _private(info, mode: int) -> bool:
    return (not stat.S_ISLNK(info.st_mode)
            and not (getattr(info, 'st_file_attributes', 0) & 0x400)
            and (os.name == 'nt' or (info.st_uid == os.getuid()
                                    and stat.S_IMODE(info.st_mode) & ~mode == 0)))


def _windows_private(paths: list[Path], *, protect: bool = False) -> bool:
    if os.name != 'nt':
        return True
    # chmod does not restrict Windows ACLs. Protect the directory before files
    # inherit it, and verify both directory and file ACLs on discovery.
    script = r'''
$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($path in (ConvertFrom-Json $env:WORKSTEP_CLI_ACL_PATHS)) {
  $acl=Get-Acl -LiteralPath $path
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  # Elevated Windows processes create objects owned by Administrators. Only
  # normalize that trusted owner when protecting; discovery still requires self.
  if ($owner -ne $sid.Value -and -not ($env:WORKSTEP_CLI_ACL_PROTECT -eq '1' -and $owner -eq 'S-1-5-32-544')) { exit 1 }
  if ($env:WORKSTEP_CLI_ACL_PROTECT -eq '1') {
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    $acl.SetOwner($sid)
    if (Test-Path -LiteralPath $path -PathType Container) {
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    } else {
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')
    }
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $path -AclObject $acl
    $acl=Get-Acl -LiteralPath $path
  }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 1 }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')) { exit 1 }
  }
}
'''
    try:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
            env={**os.environ, 'WORKSTEP_CLI_ACL_PATHS': json.dumps([str(p) for p in paths]),
                 'WORKSTEP_CLI_ACL_PROTECT': '1' if protect else '0'},
            capture_output=True, timeout=10)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _read(url: str) -> dict:
    try:
        path = credential_path(url)
        directory = path.parent.lstat()
        if not stat.S_ISDIR(directory.st_mode) or not _private(directory, 0o700):
            return {}
        if not _windows_private([path.parent, path]):
            return {}
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(fd, 'r', encoding='utf-8') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or not _private(info, 0o600)
                    or path.is_symlink() or info.st_size > 4096):
                return {}
            value = json.load(stream)
        if not isinstance(value, dict) or value.get('url') != local_origin(url):
            return {}
        if (not isinstance(value.get('token'), str) or len(value['token']) != 64
                or any(c not in '0123456789abcdef' for c in value['token'])):
            return {}
        pid = value.get('pid')
        if not isinstance(pid, int) or pid <= 0:
            return {}
        # os.kill(pid, 0) is a liveness probe only on POSIX. On Windows the
        # server's per-launch nonce rejects stale files; never call os.kill.
        if os.name != 'nt':
            os.kill(pid, 0)
        return value
    except (OSError, ValueError, TypeError):
        return {}


def local_cli_headers(url: str) -> dict[str, str]:
    if local_origin(url) is None:
        return {}
    value = _read(url)
    return {HEADER: value['token']} if value else {}


class LocalCliRuntime:
    def __init__(self, url: str):
        self.url = local_origin(url)
        if self.url is None:
            raise ValueError('CLI discovery requires a loopback daemon URL')
        self.token = secrets.token_hex(32)

    def publish(self) -> None:
        path = credential_path(self.url)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = path.parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or not _private(info, 0o700):
            raise PermissionError('CLI runtime directory must be owner-private')
        if not _windows_private([path.parent], protect=True):
            raise PermissionError('CLI runtime directory ACL must be owner-private')
        fd, temporary = tempfile.mkstemp(prefix='.cli-', dir=path.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump({'url': self.url, 'pid': os.getpid(), 'token': self.token}, stream)
            if not _windows_private([Path(temporary)], protect=True):
                raise PermissionError('CLI runtime file ACL must be owner-private')
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def close(self) -> None:
        if _read(self.url).get('token') == self.token:
            credential_path(self.url).unlink(missing_ok=True)

    def accepts(self, request) -> bool:
        # Browser metadata and forwarded requests are not local process calls.
        if (not request.client or request.client.host not in LOOPBACK
                or request.url.hostname not in LOOPBACK
                or 'gateway_remote_actor' in request.scope
                or any(key in request.headers for key in (
                    'origin', 'forwarded', 'x-forwarded-for', 'x-forwarded-host'))
                or any(key.startswith('sec-fetch-') for key in request.headers)):
            return False
        supplied = request.headers.get(HEADER)
        return bool(supplied and supplied.isascii() and hmac.compare_digest(supplied, self.token))


def local_cli_authenticated(request) -> bool:
    runtime = getattr(request.app.state, 'local_cli_runtime', None)
    return isinstance(runtime, LocalCliRuntime) and runtime.accepts(request)
