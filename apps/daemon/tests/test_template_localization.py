"""Translations preserve workflow structure and existing user assets."""
import asyncio
import json
import re
import time
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from api import templates
from services.workflow_definition import WorkflowDefinition


def test_shipped_templates_have_matching_english_variants():
    files = {p.stem: json.loads(p.read_text()) for p in templates.TEMPLATES_DIR.glob('*.json')}
    chinese = {key: value for key, value in files.items() if not key.endswith('-en')}
    assert len(chinese) == 12
    for key, source in chinese.items():
        english = files[key + '-en']
        assert source['locale'] == 'zh-CN'
        assert english['locale'] == 'en-US'
        assert source['default'] and english['default']
        assert not re.search(r'[\u3400-\u9fff]', json.dumps(english, ensure_ascii=False))
        for document in (source, english):
            assert document['id'] and document['name']
            WorkflowDefinition.load(document['steps']).validate()
        assert source['steps']['connections'] == english['steps']['connections']
        for left, right in zip(source['steps']['nodes'], english['steps']['nodes'], strict=True):
            for field in ('id', 'type', 'engine', 'model', 'position'):
                assert left.get(field) == right.get(field)
            assert len(left.get('inputs', [])) == len(right.get('inputs', []))
            assert len(left.get('outputs', [])) == len(right.get('outputs', []))


def test_legacy_metadata_and_independent_save(tmp_path, monkeypatch):
    monkeypatch.setattr(templates, 'GLOBAL_TEMPLATES_DIR', tmp_path)
    legacy = {'nodes': [], 'connections': []}
    (tmp_path / 'dev-workflow.json').write_text(json.dumps(legacy))
    templates.ensure_global_templates()
    assert json.loads((tmp_path / 'dev-workflow.json').read_text()) == legacy
    loaded = templates._get_template_sync('dev-workflow')
    assert loaded['steps'] == legacy
    assert loaded['locale'] == 'zh-CN' and loaded['default']
    templates._save_template_sync(templates.SaveTemplateRequest(id='dev-workflow-en', name='Edited', description='', steps=legacy))
    assert templates._get_template_sync('dev-workflow-en')['locale'] == 'en-US'
    assert json.loads((tmp_path / 'dev-workflow.json').read_text()) == legacy
    assert next(x for x in templates._list_templates_sync()['templates'] if x['id'] == 'dev-workflow')['locale'] == 'zh-CN'
    templates._save_template_sync(templates.SaveTemplateRequest(id='mine', name='Mine', description='', steps=legacy))
    assert not templates._get_template_sync('mine').get('locale')


@pytest.mark.asyncio
async def test_slow_template_read_keeps_health_responsive(tmp_path, monkeypatch):
    monkeypatch.setattr(templates, 'GLOBAL_TEMPLATES_DIR', tmp_path)
    original = templates._list_templates_sync
    def slow():
        time.sleep(.2)
        return original()
    monkeypatch.setattr(templates, '_list_templates_sync', slow)
    app = FastAPI(); app.include_router(templates.router)
    @app.get('/health')
    async def health(): return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/templates/list'))
        await asyncio.sleep(.03)
        assert (await asyncio.wait_for(client.get('/health'), .1)).json()['ok']
        assert (await pending).status_code == 200
