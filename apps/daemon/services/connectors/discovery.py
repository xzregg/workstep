"""Read known local configurations without modifying or returning credentials."""
import hashlib
import json
import shutil
import tomllib
from pathlib import Path


def scan_local(home: Path | None = None):
    home = home or Path.home()
    files = [home / '.codex/config.toml', home / '.claude.json',
             home / 'Library/Application Support/Claude/claude_desktop_config.json',
             home / '.config/Claude/claude_desktop_config.json']
    result = []
    for file in files:
        if not file.is_file() or file.is_symlink() or file.stat().st_size > 2 * 1024 * 1024:
            continue
        try:
            text = file.read_text(encoding='utf-8')
            data = tomllib.loads(text) if file.suffix == '.toml' else json.loads(text)
            servers = data.get('mcp_servers', data.get('mcpServers', {}))
            for name, server in servers.items():
                if not isinstance(server, dict):
                    continue
                # Definitions are imported explicitly through the form. Never return
                # raw env, headers or command arguments from another application's file.
                result.append({
                    'id': hashlib.sha256(f'{file}:{name}'.encode()).hexdigest()[:24],
                    'name': str(name)[:100], 'source': str(file), 'kind': 'mcp',
                    'transport': 'http' if server.get('url') else 'stdio',
                    'command': str(server.get('command', '')),
                    'requires_credentials': bool(server.get('env') or server.get('http_headers') or server.get('headers') or server.get('bearer_token_env_var')),
                    'requires_review': True,
                })
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    for command, name in [('dws', '钉钉 CLI'), ('gh', 'GitHub CLI')]:
        path = shutil.which(command)
        if path:
            result.append({'id': f'cli-{command}', 'name': name, 'source': path,
                           'kind': 'cli', 'transport': 'stdio', 'command': path,
                           'requires_credentials': True, 'requires_review': True})
    return result
