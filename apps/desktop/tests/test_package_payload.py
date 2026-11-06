"""Release payload hygiene, with synthetic secrets only."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / 'scripts/package_payload.py'


def run(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True)


def test_copy_keeps_runtime_assets_and_excludes_local_material(tmp_path):
    source, target = tmp_path / 'source', tmp_path / 'payload'
    allowed = ['main.py', 'data/skills/tool/references/guide.md', 'data/templates/default.json',
               'data/skins/theme.js', 'assets/app.js', 'LICENSE']
    excluded = ['.env', 'data/.env.production', 'services/private.key', 'services/token.pem',
                'data/plans/draft.md', 'data/tmp/log.txt', 'services/__pycache__/a.pyc',
                'data/tests/example.py', '.workstep/settings.json', 'data/settings.local.json',
                'assets/app.js.map', 'assets/app.js.bak', 'data/debug.log', '.DS_Store',
                'services/secrets.env', 'data/.aws/credentials', 'data/secrets.json']
    for name in allowed + excluded:
        file = source / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text('fixture', encoding='utf-8')
    result = run('copy', source, target)
    assert result.returncode == 0, result.stderr
    assert sorted(str(p.relative_to(target)) for p in target.rglob('*') if p.is_file()) == sorted(allowed)
    assert all((source / name).exists() for name in excluded), 'source files must never be deleted'


def test_secret_in_ordinary_source_blocks_copy_without_printing_value(tmp_path):
    source, target = tmp_path / 'source', tmp_path / 'payload'
    source.mkdir()
    secret = 'gh' + 'p_' + 'a' * 36
    (source / 'module.py').write_text('credential = ' + repr(secret))
    result = run('copy', source, target)
    assert result.returncode != 0
    assert secret not in result.stdout + result.stderr
    assert not target.exists(), 'validate all files before writing the destination'


def test_check_rejects_dirty_payload_and_symlink_escape(tmp_path):
    root = tmp_path / 'payload'
    root.mkdir()
    (root / '.env').write_text('private=value')
    assert run('check', root).returncode != 0
    (root / '.env').unlink()
    outside = tmp_path / 'private.txt'
    outside.write_text('private')
    (root / 'linked.txt').symlink_to(outside)
    assert run('copy', root, tmp_path / 'out').returncode != 0
    assert run('check', root).returncode != 0


def test_copy_refuses_existing_destination(tmp_path):
    source, target = tmp_path / 'source', tmp_path / 'target'
    source.mkdir(); target.mkdir()
    (target / 'user.txt').write_text('keep')
    assert run('copy', source, target).returncode != 0
    assert (target / 'user.txt').read_text() == 'keep'


def test_release_entrypoints_enforce_payload_checks():
    for suffix in ['sh', 'ps1']:
        text = (ROOT / f'apps/desktop/build-backend.{suffix}').read_text()
        assert 'package_payload.py' in text
        assert 'copy' in text and 'check' in text
    docker = (ROOT / 'Dockerfile').read_text()
    assert 'package_payload.py' in docker
    assert '--ignore-runtime-venv' in docker
    hook = (ROOT / 'apps/desktop/scripts/validate-sandbox-release.cjs').read_text()
    assert 'package_payload.py' in hook, 'check injected payload again before electron-builder'


def test_docker_context_excludes_private_and_nonruntime_paths():
    lines = (ROOT / '.dockerignore').read_text().splitlines()
    for pattern in ['**/.env*', '**/*.pem', '**/*.key', '**/plans', '**/tmp', '**/tests', '**/*.map']:
        assert pattern in lines


def test_reviewed_runtime_role_example_and_real_sources_pass():
    for source in [ROOT / 'apps/daemon/data', ROOT / 'apps/desktop/src']:
        assert run('check', source).returncode == 0
