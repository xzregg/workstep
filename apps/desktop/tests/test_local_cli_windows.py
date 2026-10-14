"""Native Windows ACL regression for the packaged daemon's CLI discovery."""
import importlib.util
import os
from pathlib import Path
import subprocess

import pytest

pytestmark = pytest.mark.skipif(os.name != 'nt', reason='Native Windows ACL contract')
module_path = Path(__file__).resolve().parents[2] / 'daemon/services/local_cli.py'
spec = importlib.util.spec_from_file_location('workstep_local_cli_windows', module_path)
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


@pytest.fixture(autouse=True)
def acl_failure_diagnostics(monkeypatch):
    original = subprocess.run

    def run(*args, **kwargs):
        result = original(*args, **kwargs)
        if result.returncode:
            # ACL helpers do not receive or print the credential token.
            print('Windows ACL helper exit:', result.returncode)
            print(result.stdout.decode(errors='replace'))
            print(result.stderr.decode(errors='replace'))
        return result

    monkeypatch.setattr(subprocess, 'run', run)


def test_windows_cli_publishes_private_credentials_in_unicode_directory(tmp_path, monkeypatch):
    monkeypatch.setenv('WORKSTEP_CONFIG_DIR', str(tmp_path / '配置 WorkStep'))
    runtime = cli.LocalCliRuntime('http://127.0.0.1:43123')
    try:
        runtime.publish()
        path = cli.credential_path(runtime.url)
        assert cli._windows_private([path.parent, path])
        assert cli.local_cli_headers(runtime.url) == {cli.HEADER: runtime.token}
        assert cli.local_cli_headers('http://127.0.0.1:43124') == {}
        assert cli.local_cli_headers('http://192.0.2.1:43123') == {}
    finally:
        runtime.close()
    assert not path.exists()


def test_windows_cli_rejects_credential_file_readable_by_everyone(tmp_path, monkeypatch):
    monkeypatch.setenv('WORKSTEP_CONFIG_DIR', str(tmp_path / '配置 WorkStep'))
    runtime = cli.LocalCliRuntime('http://127.0.0.1:43123')
    runtime.publish()
    path = cli.credential_path(runtime.url)
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', r'''
$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:WORKSTEP_TEST_CLI_PATH
$everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,'Read','Allow'))
Set-Acl -LiteralPath $env:WORKSTEP_TEST_CLI_PATH -AclObject $acl
'''], env={**os.environ, 'WORKSTEP_TEST_CLI_PATH': str(path)}, capture_output=True)
    assert result.returncode == 0, result.stderr.decode(errors='replace')
    assert cli.local_cli_headers(runtime.url) == {}
    assert cli._windows_private([path], protect=True)
    runtime.close()
    assert not path.exists()
