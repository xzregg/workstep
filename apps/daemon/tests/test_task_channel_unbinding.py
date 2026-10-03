"""Successful task lifecycle actions release channel bindings, preserving history."""
import asyncio
from copy import deepcopy
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import main
from services.channels.bots import BotManager
from streaming.bus import EventBus
from tests.test_api_contracts import api_context, _create_test_workflow


@pytest.fixture
async def bound_task(api_context, monkeypatch):
    client, tmp_path = api_context
    project_dir = tmp_path / 'channel-lifecycle'
    project_dir.mkdir()
    pid = (await client.post('/api/project/init', json={'path': str(project_dir)})).json()['id']
    await _create_test_workflow(client, pid)
    response = await client.post(f'/api/task/create?project_id={pid}', json={'title': '渠道任务', 'cwd': str(project_dir)})
    assert response.status_code == 200
    tid = response.json()['id']
    data = {'bots': [{'id': 'bot', 'enabled': True, 'platform': 'wecom',
                     'default_target_type': 'task', 'default_project_id': pid, 'default_task_id': tid}],
            'groups': [{'bot_id': 'bot', 'group_id': group, 'project_id': project, 'task_id': task}
                       for group, project, task in [('room-1', pid, tid), ('room-2', pid, tid),
                                                     ('other-task', pid, 'another'), ('other-project', 'other', tid)]],
            'sessions': {'bot:group:room-1': 'history'},
            'session_sources': {'history': {'project_id': pid, 'sender_id': 'user'}},
            'recent_groups': [{'bot_id': 'bot', 'group_id': 'room-1'}]}
    values = {'channel_bots': data}
    store = SimpleNamespace(get=lambda key, default=None: deepcopy(values.get(key, default)),
                            set=lambda key, value: values.__setitem__(key, deepcopy(value)))
    manager = BotManager(store, main.project_manager, EventBus(), SimpleNamespace(), AsyncMock(), adapter_factories={})
    manager._registered_channels = {}
    monkeypatch.setattr(main, 'channel_bot_manager', manager)
    return client, pid, tid, manager, store, values


@pytest.mark.parametrize('action', ['archive', 'delete', 'confirm', 'confirm-empty'])
async def test_successful_lifecycle_unbinds_only_that_task(bound_task, monkeypatch, action):
    client, pid, tid, manager, _, values = bound_task
    original = deepcopy(values['channel_bots'])
    if action == 'archive':
        result = await client.post(f'/api/task/archive?project_id={pid}', json={'task_id': tid})
    elif action == 'delete':
        result = await client.request('DELETE', f'/api/task/delete?project_id={pid}', json={'task_id': tid, 'delete_workspace': False})
    else:
        experience = '- 经验：核对回复来源。'
        if action == 'confirm-empty':
            monkeypatch.setattr(main.coordinator_module, 'draft_archive_experience', AsyncMock(return_value='- 未发现值得记录的错误经验。'))
            prepared = await client.post(f'/api/task/{tid}/archive-experience/prepare?project_id={pid}&message_id=empty-draft')
            assert prepared.status_code == 200
            experience = ''
        result = await client.post(f'/api/task/{tid}/archive-experience/confirm?project_id={pid}', json={'experience': experience})
    assert result.status_code == 200, result.text
    data = await manager._load()
    assert [(r['group_id'], r['project_id'], r['task_id']) for r in data['groups']] == [
        ('other-task', pid, 'another'), ('other-project', 'other', tid)]
    assert data['bots'][0]['default_target_type'] == 'project'
    assert data['bots'][0]['default_project_id'] == pid
    assert data['bots'][0]['default_task_id'] == ''
    for key in ['sessions', 'session_sources', 'recent_groups']:
        assert data[key] == original[key]
    assert (await client.get(f'/api/task/{tid}/discussion-groups?project_id={pid}')).json() == []
    if action != 'delete':
        assert (await client.post(f'/api/task/unarchive?project_id={pid}', json={'task_id': tid})).status_code == 200
        assert await manager.list_task_groups(pid, tid) == []


@pytest.mark.parametrize('action', ['archive', 'delete', 'confirm'])
async def test_rejected_lifecycle_keeps_bindings(bound_task, action):
    client, pid, tid, _, _, values = bound_task
    original = deepcopy(values)
    from models.task import Task
    await main.project_manager.run_db(pid, lambda _project: Task.update(status='running').where(Task.id == tid).execute())
    if action == 'archive':
        result = await client.post(f'/api/task/archive?project_id={pid}', json={'task_id': tid})
    elif action == 'delete':
        result = await client.request('DELETE', f'/api/task/delete?project_id={pid}', json={'task_id': tid, 'delete_workspace': False})
    else:
        result = await client.post(f'/api/task/{tid}/archive-experience/confirm?project_id={pid}', json={'experience': '- 经验：核对来源。'})
    assert result.status_code == 409
    assert values == original


async def test_archive_unbinding_slow_config_write_keeps_health_responsive(bound_task):
    client, pid, tid, _, store, _ = bound_task
    entered, release = threading.Event(), threading.Event()
    original = store.set
    def slow_set(*args):
        entered.set()
        assert release.wait(3)
        original(*args)
    store.set = slow_set
    request = asyncio.create_task(client.post(f'/api/task/archive?project_id={pid}', json={'task_id': tid}))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
    finally:
        release.set()
    assert (await request).status_code == 200
