import asyncio
import io
import json
import time
import zipfile
import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

def package(root):
    from services.languages import read_contract
    root.mkdir(parents=True, exist_ok=True)
    contract = read_contract()
    manifest = dict(schema_version=1, id='spanish', locale='es-ES', name='西班牙语', native_name='Español', version='1.0.0', fallback_locale='en-US', direction='ltr', catalog_revision=contract['revision'])
    messages = {key: contract['messages'][key] for key in contract['required_keys']}
    messages['nav.settings'] = 'Ajustes'
    (root / 'manifest.json').write_text(json.dumps(manifest))
    (root / 'messages.json').write_text(json.dumps(messages))
    return root

@pytest.mark.asyncio
@pytest.mark.parametrize('locale', ['fr-FR', 'de-DE', 'ar'])
async def test_new_builtin_languages_are_protected_and_available_as_fallbacks(tmp_path, locale):
    from services.languages import LanguageManager
    from services.appearance_preferences import AppearanceSelection
    assert AppearanceSelection(language=locale).language == locale
    root = package(tmp_path / 'draft')
    manifest_path = root / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest['fallback_locale'] = locale
    manifest_path.write_text(json.dumps(manifest))
    manager = LanguageManager(tmp_path / 'runtime')
    assert (await manager.validate(str(root)))['ok']
    manifest['locale'] = locale
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match='内置语言不可覆盖'):
        await manager.validate(str(root))

@pytest.mark.asyncio
async def test_language_install_is_immutable_with_coverage_and_conflicts(tmp_path):
    from services.languages import LanguageManager, LanguageConflict
    manager = LanguageManager(tmp_path / 'runtime')
    root = package(tmp_path / 'draft')
    result = await manager.validate(str(root))
    assert result['coverage']['missing']
    assert result['package']['manifest']['locale'] == 'es-ES'
    assert await manager.list() == []
    installed = await manager.register(str(root))
    assert (await manager.get('spanish'))['messages']['nav.settings'] == 'Ajustes'
    with pytest.raises(LanguageConflict): await manager.register(str(root))
    (root / 'messages.json').write_text('{}')
    with pytest.raises(ValueError): await manager.register(str(root), replace=True)
    assert (await manager.get('spanish'))['revision'] == installed['revision']
    (manager.root / 'language-packs' / '.language-pending').write_text('incomplete')
    assert len(await manager.list()) == 1
    data = await manager.export('spanish')
    await manager.delete('spanish')
    assert (await manager.import_zip(data))['revision'] == installed['revision']

@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['placeholder', 'critical', 'builtin', 'unknown', 'html', 'rtl', 'symlink', 'extra'])
async def test_invalid_language_packages_are_rejected(tmp_path, change):
    from services.languages import LanguageManager
    root = package(tmp_path / 'draft')
    manifest = json.loads((root / 'manifest.json').read_text())
    messages = json.loads((root / 'messages.json').read_text())
    if change == 'placeholder': messages['common.confirm'] += ' {invented}'
    if change == 'critical': messages.pop('interaction.deny')
    if change == 'builtin': manifest['locale'] = 'en-US'
    if change == 'unknown': messages['__proto__'] = 'invalid'
    if change == 'html': messages['common.confirm'] = '<script>evil</script>'
    if change == 'rtl': manifest['direction'] = 'rtl'
    (root / 'manifest.json').write_text(json.dumps(manifest)); (root / 'messages.json').write_text(json.dumps(messages))
    if change == 'extra': (root / 'execute.js').write_text('evil')
    if change == 'symlink': (root / 'extra.json').symlink_to(tmp_path / 'outside')
    with pytest.raises(ValueError): await LanguageManager(tmp_path / 'runtime').validate(str(root))

@pytest.mark.asyncio
async def test_zip_paths_and_duplicate_json_keys_are_rejected(tmp_path):
    from services.languages import LanguageManager
    manager = LanguageManager(tmp_path / 'runtime')
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z: z.writestr('../manifest.json', '{}')
    with pytest.raises(ValueError): await manager.import_zip(out.getvalue())
    root = package(tmp_path / 'draft'); (root / 'messages.json').write_text('{"nav.settings":"a","nav.settings":"b"}')
    with pytest.raises(ValueError): await manager.validate(str(root))

@pytest.mark.asyncio
async def test_language_api_permissions_and_slow_disk_canary(tmp_path, monkeypatch):
    from api import languages
    from services.languages import LanguageManager
    manager = LanguageManager(tmp_path / 'runtime'); monkeypatch.setattr(languages, 'manager', manager)
    root = package(tmp_path / 'draft')
    app = FastAPI(); app.include_router(languages.router)
    app.dependency_overrides[languages.authorize] = lambda: None
    @app.get('/health')
    async def health(): return {'ok': True}
    read = manager._read_package
    def slow(*args, **kwargs): time.sleep(.25); return read(*args, **kwargs)
    monkeypatch.setattr(manager, '_read_package', slow)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.post('/api/language-packs/validate', json={'path': str(root)}))
        await asyncio.sleep(.05)
        assert (await asyncio.wait_for(client.get('/health'), .1)).status_code == 200
        assert (await pending).status_code == 200
        assert (await client.post('/api/language-packs/register', json={'path': str(root)})).status_code == 200
        assert (await client.get('/api/language-packs/spanish')).json()['manifest']['native_name'] == 'Español'
    from services.remote_access import ActorSnapshot, actor_context
    app.dependency_overrides.clear()
    actor = ActorSnapshot(actor_id='viewer', user_name='viewer', device_id='device', device_name='device', source='remote', project_id='project', access_level='edit')
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            assert (await client.get('/api/language-packs?project_id=project')).status_code == 200
            assert (await client.get('/api/language-packs?project_id=other')).status_code == 403
            for action in ['validate', 'register']:
                assert (await client.post('/api/language-packs/' + action + '?project_id=project', json={'path': str(root)})).status_code == 403
            assert (await client.post('/api/language-packs/import?project_id=project', content=b'zip')).status_code == 403
            assert (await client.delete('/api/language-packs/spanish?project_id=project')).status_code == 403

@pytest.mark.asyncio
@pytest.mark.parametrize('field,value', [('id', 12), ('schema_version', True), ('catalog_revision', 'invalid')])
async def test_invalid_manifest_types_are_validation_errors(tmp_path, field, value):
    from services.languages import LanguageManager
    root = package(tmp_path / 'draft')
    manifest = json.loads((root / 'manifest.json').read_text()); manifest[field] = value
    (root / 'manifest.json').write_text(json.dumps(manifest))
    with pytest.raises(ValueError): await LanguageManager(tmp_path / 'runtime').validate(str(root))
