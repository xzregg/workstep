import asyncio
import io
import json
import time
import zipfile

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from services.skins import SkinManager


def package(root):
    root.mkdir()
    (root / 'skin.json').write_text(json.dumps({
        'id': 'calendar', 'name': '日历', 'version': '1', 'schema_version': 2,
        'tokens': {'bg': '#fafafa'}, 'layout': {'composerPosition': 'left'},
        'effects': {'reveal': True, 'charsPerSecond': 90, 'maxDurationMs': 3000},
        'menus': [{'id': 'tools', 'label': '工具', 'position': 'right',
                   'items': [{'label': '任务', 'action': 'navigate', 'args': {'path': '/tasks'}}]}],
    }))
    (root / 'theme.css').write_text(':root { --card-gap: 12px; } [data-ui="message"] { animation: arrive 1s; } @keyframes arrive { from { opacity: 0; } to { opacity: 1; } }')
    (root / 'theme.js').write_text('export function activate(api) { return () => {}; }')
    return root


@pytest.mark.asyncio
async def test_v2_roundtrip_and_draft_preserves_code(tmp_path):
    manager = SkinManager(tmp_path / 'runtime')
    root = package(tmp_path / 'draft')
    checked = await manager.validate(str(root))
    skin = checked['skin']
    assert skin['layout']['composerPosition'] == 'left'
    assert 'data-skin-id="calendar"' in skin['css']
    assert 'calendar-arrive' in skin['css']
    assert skin['script'] == 'theme.js'
    assert skin['effects']['charsPerSecond'] == 90
    original = (root / 'theme.js').read_bytes()
    skin['tokens']['bg'] = '#ffffff'
    saved = await manager.save_draft(str(root), skin['revision'], skin)
    assert (root / 'theme.js').read_bytes() == original
    assert saved['skin']['manifest']['schema_version'] == 2
    assert not (root / 'tokens.json').exists()
    installed = await manager.register(str(root))
    exported = await manager.export('calendar')
    with zipfile.ZipFile(io.BytesIO(exported)) as archive:
        assert 'theme.js' in archive.namelist()
        assert 'theme.css' in archive.namelist()
    assert (await manager.get('calendar'))['revision'] == installed['revision']
    assert (await manager.file(installed['revision'], 'theme.js'))[0] == original


@pytest.mark.asyncio
async def test_copying_v2_snapshot_keeps_script_and_recompiles_css_for_new_id(tmp_path, monkeypatch):
    from services import customization_workspace
    monkeypatch.setattr(customization_workspace, 'workspace_root', lambda: tmp_path)
    manager = SkinManager(tmp_path / 'runtime')
    source = package(tmp_path / 'source')
    installed = await manager.register(str(source))
    copy = {**installed, 'manifest': {**installed['manifest'], 'id': 'calendar-copy'}}
    target = tmp_path / 'copy'
    saved = await manager.save_draft(str(target), '', copy)
    assert (target / 'theme.js').read_bytes() == (source / 'theme.js').read_bytes()
    assert (target / 'theme.css').read_bytes() == (source / 'theme.css').read_bytes()
    assert 'data-skin-id="calendar-copy"' in saved['skin']['css']
    assert saved['skin']['revision'] != installed['revision']
    assert not (target / 'components.json').exists()


@pytest.mark.asyncio
async def test_non_object_manifest_is_a_validation_error(tmp_path):
    manager = SkinManager(tmp_path / 'runtime')
    root = package(tmp_path / 'draft')
    (root / 'skin.json').write_text('[]')
    with pytest.raises(ValueError, match='JSON 对象'):
        await manager.validate(str(root))


@pytest.mark.asyncio
@pytest.mark.parametrize('css', ['@import "https://example.com/a.css";', 'a { background: url(../private.png) }', '@media (min-width: 1px) { a { background: url(https://example.com/a.png) } }', 'a { color: red; } garbage'])
async def test_v2_rejects_invalid_or_external_css(tmp_path, css):
    manager = SkinManager(tmp_path / 'runtime')
    root = package(tmp_path / 'draft')
    (root / 'theme.css').write_text(css)
    with pytest.raises(ValueError):
        await manager.validate(str(root))


@pytest.mark.asyncio
async def test_v2_assets_are_scoped_and_file_api_stays_responsive(tmp_path, monkeypatch):
    from api import skins
    manager = SkinManager(tmp_path / 'runtime')
    root = package(tmp_path / 'draft')
    (root / 'assets').mkdir()
    (root / 'assets' / 'bg.png').write_bytes(b'\x89PNG\r\n\x1a\n')
    (root / 'theme.css').write_text('[data-ui="workspace"] { background-image: url("assets/bg.png"); }')
    skin = await manager.register(str(root))
    assert f'/api/skins/files/{skin["revision"]}/assets/bg.png' in skin['css']
    app = FastAPI()
    app.include_router(skins.router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    app.dependency_overrides[skins.authorize_read] = lambda: None
    monkeypatch.setattr(skins, 'manager', manager)
    original = manager._file
    def slow(*args):
        time.sleep(.15)
        return original(*args)
    monkeypatch.setattr(manager, '_file', slow)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get(f'/api/skins/files/{skin["revision"]}/theme.js'))
        await asyncio.sleep(.03)
        assert (await asyncio.wait_for(client.get('/health'), .05)).json()['ok']
        assert not pending.done(), 'file reads must run outside the event loop'
        response = await pending
        assert response.status_code == 200
        assert response.headers['content-type'].startswith('text/javascript')
        assert (await client.get(f'/api/skins/files/{skin["revision"]}/skin.json')).status_code == 400
