"""Expose the WorkStep credential helper to daemon child processes only.

Git invokes this file directly, so the helper uses only the standard library
and reads the current atomic credential file on every request. No tokens are
copied into engine configuration, environment variables or command lines.
"""

import json
import os
import shlex
import sys
from pathlib import Path

def install_engine_credentials(credential_file: Path):
    """Install inherited Git configuration without changing the user's gitconfig.

    This function does no I/O and is safe during async daemon startup. The
    synchronous file read runs in Git's separate credential-helper process.
    """
    command = ' '.join(shlex.quote(str(value)) for value in (
        sys.executable, __file__, credential_file,
    ))
    # Use the same single-variable representation Git propagates for `git -c`.
    # Unlike GIT_CONFIG_KEY_n, this name survives KEY/TOKEN/SECRET filters;
    # engines need no Git-specific configuration or exceptions.
    previous = os.environ.get('GIT_CONFIG_PARAMETERS')
    # Git's single-quote parser accepts backslash-escaped apostrophes, not
    # shlex.quote's double-quote splice for paths containing apostrophes.
    parameter = "'" + f'credential.helper=!{command}'.replace("'", "'\\''") + "'"
    os.environ['GIT_CONFIG_PARAMETERS'] = ' '.join(
        value for value in (previous, parameter) if value
    )

    def restore():
        if previous is None:
            os.environ.pop('GIT_CONFIG_PARAMETERS', None)
        else:
            os.environ['GIT_CONFIG_PARAMETERS'] = previous

    return restore


def credential_response(path: Path, operation: str, request: str) -> str:
    """Implement Git's get protocol; store/erase never change saved UI settings."""
    if operation != 'get':
        return ''
    fields = {}
    for line in request.splitlines():
        if not line:
            break
        key, separator, value = line.partition('=')
        if separator:
            fields[key] = value
    if fields.get('protocol') != 'https':
        return ''
    try:
        credentials = json.loads(path.read_text(encoding='utf-8'))
        saved = credentials.get(fields.get('host', '').lower())
        if not isinstance(saved, dict):
            return ''
        username, token = saved.get('username'), saved.get('token')
        if not all(isinstance(value, str) and value and not any(
            character in value for character in '\r\n\0'
        ) for value in (username, token)):
            return ''
        if fields.get('username') not in (None, '', username):
            return ''
        return f'username={username}\npassword={token}\n\n'
    except (OSError, ValueError, AttributeError):
        return ''


if __name__ == '__main__':
    if len(sys.argv) == 3:
        sys.stdout.write(credential_response(Path(sys.argv[1]), sys.argv[2], sys.stdin.read()))
