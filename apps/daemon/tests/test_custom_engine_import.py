import asyncio
import io
import json
import time
import zipfile

import pytest


def package(extra=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        archive.writestr('manifest.json', json.dumps({
            'api_version': 1, 'id': 'import_test', 'name': 'Import test',
            'class_name': 'ImportEngine', 'mode': 'sdk', 'files': [],
        }))
        archive.writestr('engine.py', 'raise RuntimeError("must not execute during import")')
        archive.writestr('validation-summary.json', '{}')
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    return output.getvalue()


def test_import_stages_exported_package_without_execution_or_overwrite(tmp_path):
    from services.custom_engine_import import stage_package
    first = stage_package(package(), tmp_path)
    second = stage_package(package(), tmp_path)
    assert first != second
    assert first.parent == tmp_path
    assert (first / 'manifest.json').is_file()
    assert (first / 'engine.py').is_file()
    assert not (first / 'validation-summary.json').exists()


@pytest.mark.asyncio
async def test_existing_export_round_trips_into_import(tmp_path, monkeypatch):
    from services.custom_engines import CustomEngineManager
    from services.custom_engine_import import stage_package
    from engines.core.custom_package import load_manifest
    source = stage_package(package(), tmp_path)
    manager = CustomEngineManager()
    monkeypatch.setattr(manager, '_load', lambda path: (source, load_manifest(source)))
    (source / 'validation.json').write_text(json.dumps({'engine_id': 'import_test', 'secret': 'private'}))
    exported = await manager.export('import_test')
    target = stage_package(exported, tmp_path)
    assert (target / 'engine.py').read_bytes() == (source / 'engine.py').read_bytes()
    assert (target / 'manifest.json').read_bytes() == (source / 'manifest.json').read_bytes()
    assert not (target / 'validation.json').exists()


@pytest.mark.asyncio
async def test_failed_onboarding_removes_import_draft(tmp_path, monkeypatch):
    from services.custom_engine_import import import_package
    from services import custom_engine_onboarding as onboarding
    monkeypatch.setattr(onboarding, 'workspace_parent', lambda: tmp_path)
    async def unavailable(**kwargs): raise ValueError('先配置聊天引擎')
    monkeypatch.setattr(onboarding, 'create_onboarding', unavailable)
    with pytest.raises(ValueError, match='先配置聊天引擎'):
        await import_package(package())
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('extra', [
    {'../escape.py': 'bad'}, {'/escape.py': 'bad'}, {'folder\\escape.py': 'bad'},
    {'auth.json': '{}'}, {'validation.json': '{}'}, {'unlisted.py': 'bad'},
    {'engine.py/nested.txt': 'bad'},
])
def test_import_rejects_unsafe_or_undeclared_files_and_cleans_up(tmp_path, extra):
    from services.custom_engine_import import stage_package
    with pytest.raises(ValueError):
        stage_package(package(extra), tmp_path)
    assert not list(tmp_path.iterdir())


def test_import_rejects_symlinks_and_expanded_size_limit(tmp_path, monkeypatch):
    from services import custom_engine_import as importer
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        link = zipfile.ZipInfo('engine.py')
        link.external_attr = 0o120777 << 16
        archive.writestr(link, '/outside')
    with pytest.raises(ValueError, match='特殊文件'):
        importer.stage_package(output.getvalue(), tmp_path)
    monkeypatch.setattr(importer, 'MAX_PACKAGE', 1024)
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('resource.txt', 'a' * 2048)
    assert len(output.getvalue()) < 1024
    with pytest.raises(ValueError, match='解压后过大'):
        importer.stage_package(output.getvalue(), tmp_path)
    assert not list(tmp_path.iterdir())


@pytest.mark.asyncio
async def test_import_api_keeps_health_responsive_and_returns_import_draft(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    from api.custom_engine import router, authorize
    from services import custom_engine_import as importer
    from services import custom_engine_onboarding as onboarding
    monkeypatch.setattr(onboarding, 'workspace_parent', lambda: tmp_path)
    stage = importer.stage_package
    entered = asyncio.Event()
    loop = asyncio.get_running_loop()
    def slow_stage(*args):
        loop.call_soon_threadsafe(entered.set)
        time.sleep(.2)
        return stage(*args)
    monkeypatch.setattr(importer, 'stage_package', slow_stage)
    async def create_onboarding(package_path=None):
        assert (package_path / 'engine.py').is_file()
        return {'session_id': 'import-session', 'package_path': str(package_path), 'prompt': '导入验收'}
    monkeypatch.setattr(onboarding, 'create_onboarding', create_onboarding)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[authorize] = lambda: None
    @app.get('/health')
    async def health(): return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.post('/custom/import', content=package()))
        await asyncio.wait_for(entered.wait(), 1)
        assert (await asyncio.wait_for(client.get('/health'), .1)).json()['ok']
        response = await pending
        assert response.status_code == 200, response.text
        assert response.json()['session_id'] == 'import-session'
        assert (await client.post('/custom/import', content=b'not zip')).status_code == 400
