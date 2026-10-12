import asyncio
from types import SimpleNamespace
from unittest.mock import Mock
from pathlib import Path

import pytest


@pytest.mark.asyncio
async def test_all_creation_requests_reuse_runtime_root_without_allocating_draft_directories(tmp_path, monkeypatch):
    from services import skin_onboarding, custom_engine_onboarding, skill_onboarding
    from services.project import ProjectManager
    manager = ProjectManager()
    root = tmp_path / 'runtime'
    session_index = iter(range(4))
    module = SimpleNamespace(_resolve_engine_models=lambda: ('codex_sdk', None, None), create_session=lambda *args, **kwargs: {'id': f'session-{next(session_index)}'})
    init = Mock(wraps=manager.init_project)
    monkeypatch.setattr(manager, 'init_project', init)
    for onboarding in (skin_onboarding, custom_engine_onboarding, skill_onboarding):
        monkeypatch.setattr(onboarding, 'project_manager', manager)
        monkeypatch.setattr(onboarding, 'chat_module', lambda: module)
        monkeypatch.setattr(onboarding, 'workspace_parent', lambda: root)
        monkeypatch.setattr(onboarding.skill_center, 'runtime_selection', lambda path: None)
    try:
        results = await asyncio.gather(skin_onboarding.create_onboarding(), custom_engine_onboarding.create_onboarding(), skin_onboarding.create_onboarding(), skill_onboarding.create_onboarding())
        assert len({item['project_id'] for item in results}) == 1
        assert len({item['session_id'] for item in results}) == 4
        assert all(item['workspace_path'] == str(root) for item in results)
        assert results[0]['package_path'] == str(root / 'skin')
        assert results[1]['package_path'] == results[3]['package_path'] == str(root)
        assert not any((root / name).exists() for name in ('skills', 'engines', 'skins', 'skin'))
        init.assert_called_once()
        assert manager.get_project(root).name == '默认工作区'
        from services.skill_center import SkillCenter
        draft = Path(results[3]['package_path'])
        (draft / 'SKILL.md').write_text('---\nname: uninstalled-draft\ndescription: draft\n---\n')
        installed = tmp_path / 'installed'
        installed.mkdir()
        center = SkillCenter(source_roots={'agents': installed})
        assert not any(skill.name == 'uninstalled-draft' for skill in center.list_project(root))
        assert not list(installed.iterdir())
    finally:
        await asyncio.to_thread(manager.close_all)


@pytest.mark.asyncio
async def test_default_workspace_can_be_renamed_but_cannot_be_removed_via_api(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from api import project as api
    from services import customization_workspace as workspace
    from services.project import ProjectManager
    manager = ProjectManager()
    root = tmp_path / 'runtime'
    monkeypatch.setattr(workspace, 'workspace_root', lambda: root)
    monkeypatch.setattr(api, 'project_manager', manager)
    project = await workspace.ensure_default_workspace(manager)
    app = FastAPI(); app.include_router(api.router)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/project/rename', json={'path': str(root), 'name': '我的工作台'})
            assert response.status_code == 200
            response = await client.delete(f'/api/project/{project.id}')
            assert response.status_code == 409
            assert '不能删除' in response.json()['detail']
            summary = (await client.get(f'/api/project/{project.id}/summary')).json()
            assert summary['name'] == '我的工作台'
            assert summary['is_default_workspace'] is True
            assert manager.get_project_by_id(project.id) is project
            with pytest.raises(ValueError, match='不能删除'):
                await asyncio.to_thread(manager.unregister, project.id)
            await asyncio.to_thread(manager.close_all)
            await asyncio.to_thread(manager._load_saved_projects)
            restored = await workspace.ensure_default_workspace(manager)
            assert restored.id == project.id
            assert restored.name == '我的工作台'
    finally:
        await asyncio.to_thread(manager.close_all)


def test_runtime_project_identity_survives_restart(tmp_path):
    from services.customization_workspace import runtime_project
    from services.project import ProjectManager
    first = ProjectManager(); second = ProjectManager()
    try:
        project = runtime_project(first, tmp_path / 'runtime')
        identity = project.id
        first.close_all()
        reopened = runtime_project(second, tmp_path / 'runtime')
        assert reopened.id == identity
        assert len(second.list_projects()) == 1
    finally:
        first.close_all(); second.close_all()


@pytest.mark.asyncio
async def test_default_workspace_preparation_is_nonblocking_and_has_no_workflow(tmp_path, monkeypatch):
    import time
    from services import customization_workspace as workspace
    from services.project import ProjectManager
    manager = ProjectManager()
    root = tmp_path / 'runtime'
    monkeypatch.setattr(workspace, 'workspace_root', lambda: root)
    original = manager.init_project
    def slow_init(*args, **kwargs):
        time.sleep(.15)
        return original(*args, **kwargs)
    monkeypatch.setattr(manager, 'init_project', slow_init)
    try:
        preparing = asyncio.create_task(workspace.ensure_default_workspace(manager))
        await asyncio.sleep(.02)
        assert not preparing.done(), 'initialization must leave the event loop responsive'
        project = await preparing
        summary = await manager.run_db(project.id, manager.project_summary)
        assert summary['is_default_workspace'] is True
        assert summary['workflows'] == []
        other = await asyncio.to_thread(manager.init_project, tmp_path / 'other', name='Runtime')
        assert (await manager.run_db(other.id, manager.project_summary))['is_default_workspace'] is False
        assert (await workspace.ensure_default_workspace(manager)).id == project.id
    finally:
        await asyncio.to_thread(manager.close_all)
