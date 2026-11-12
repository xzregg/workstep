import asyncio
from pathlib import Path
import time

import pytest
from agent_assistants.prototype import PrototypeModule
from services.project import ProjectManager
from services.prototype_workspace import PrototypeWorkspace
from services.remote_access import ActorSnapshot, actor_context
from streaming.bus import EventBus


@pytest.fixture
async def prototype(tmp_path, monkeypatch):
    manager = ProjectManager()
    project = manager.init_project(tmp_path / 'prototype-project')
    (project.path / 'index.html').write_text('<button>Before</button>')
    (project.path / 'other.html').write_text('<p>Other</p>')
    work = PrototypeWorkspace.open(project.path, project.workstep_dir, project.path / 'index.html')
    bus = EventBus()
    module = PrototypeModule(bus, manager)
    monkeypatch.setattr(module, '_resolve_engine_models', lambda: ('claude', None, None))
    with actor_context(ActorSnapshot('u','Tester','d','Device','local')):
        yield module, manager, project, work, bus
    await module.shutdown()
    await bus.close()
    manager.close_all()


async def test_real_runtime_edit_history_and_document_isolation(prototype, monkeypatch):
    module, manager, project, work, bus = prototype
    seen = []
    async def invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        from services.project_storage import data_directory
        seen.append((cwd, prompt, data_directory(cwd)))
        await asyncio.to_thread((Path(cwd) / 'index.html').write_text, '<button>After</button>')
        return '已调整按钮', [], 'engine-test-session'
    monkeypatch.setattr(module, '_invoke', invoke)
    accepted = await manager.run_db(project.id, lambda _: module.submit(project.id, work.id, 'index.html', '修改按钮', 'request-1'))
    module.start_queued_turn(accepted.turn_id)
    await asyncio.wait_for(module._turn_tasks[accepted.turn_id], 5)
    from models import Task
    assert await manager.run_db(project.id,lambda _:Task.select().count()) == 0
    assert work.state()['status'] == 'idle'
    assert (project.path / 'index.html').read_text() == '<button>After</button>'
    assert seen[0][0] == str(work.directory / 'workspace')
    assert seen[0][2] == project.workstep_dir
    document_id = work.load()['documents']['index.html']
    history = await manager.run_db(project.id, lambda _: module.history(project.id, document_id))
    assert any(message['content'] == '修改按钮' for message in history['messages'])
    other = work.load()['documents']['other.html']
    assert await manager.run_db(project.id, lambda _: module.history(project.id, other)) is None
    restored = PrototypeModule(bus, manager)
    again = await manager.run_db(project.id, lambda _: restored.history(project.id, document_id))
    assert again['engine_session_id'] == 'engine-test-session'
    await restored.shutdown()


async def test_failed_engine_keeps_original_and_work_copy(prototype, monkeypatch):
    module, manager, project, work, _ = prototype
    async def invoke(*args, **kwargs):
        await asyncio.to_thread((work.directory / 'workspace/index.html').write_text, 'partial')
        raise RuntimeError('simulated engine interruption')
    monkeypatch.setattr(module, '_invoke', invoke)
    accepted = await manager.run_db(project.id, lambda _: module.submit(project.id, work.id, 'index.html', '修改按钮', 'request-2'))
    module.start_queued_turn(accepted.turn_id)
    await asyncio.wait_for(module._turn_tasks[accepted.turn_id], 5)
    assert work.state()['status'] == 'interrupted'
    assert (project.path / 'index.html').read_text() == '<button>Before</button>'
    assert (work.directory / 'workspace/index.html').read_text() == 'partial'


async def test_slow_history_db_does_not_block_loop(prototype, monkeypatch):
    module, manager, project, work, _ = prototype
    original = module._config.persistence.load_history
    def slow(*args):
        time.sleep(.15)
        return original(*args)
    monkeypatch.setattr(module._config.persistence, 'load_history', slow)
    request = asyncio.create_task(manager.run_db(project.id, lambda _: module.history(project.id, work.load()['documents']['index.html'])))
    await asyncio.sleep(.02)
    start = time.monotonic()
    await asyncio.sleep(.01)
    assert time.monotonic() - start < .08
    await request


async def test_publish_conflict_is_a_persisted_failed_turn(prototype, monkeypatch):
    module, manager, project, work, _ = prototype
    async def invoke(*args, **kwargs):
        await asyncio.to_thread((work.directory / 'workspace/index.html').write_text, '<p>model</p>')
        await asyncio.to_thread((project.path / 'index.html').write_text, '<p>external</p>')
        return '修改完成', [], 'engine-id'
    monkeypatch.setattr(module, '_invoke', invoke)
    accepted = await manager.run_db(project.id, lambda _: module.submit(project.id, work.id, 'index.html', '改字', 'conflict'))
    module.start_queued_turn(accepted.turn_id)
    await module._turn_tasks[accepted.turn_id]
    assert module._turn_states[accepted.turn_id]['status'] == 'error'
    assert work.state()['status'] == 'conflict'
    assert (project.path / 'index.html').read_text() == '<p>external</p>'
    doc = work.load()['documents']['index.html']
    history = await manager.run_db(project.id, lambda _: module.history(project.id, doc))
    assert history['messages'][-1]['status'] == 'error'


async def test_stop_preserves_draft_and_finalizes_session(prototype, monkeypatch):
    module, manager, project, work, _ = prototype
    ready = asyncio.Event()
    async def invoke(*args, **kwargs):
        await asyncio.to_thread((work.directory / 'workspace/index.html').write_text, 'partial')
        ready.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(module, '_invoke', invoke)
    accepted = await manager.run_db(project.id, lambda _: module.submit(project.id, work.id, 'index.html', '改字', 'stop'))
    module.start_queued_turn(accepted.turn_id)
    await asyncio.wait_for(ready.wait(), 3)
    await module.stop_current(accepted.session_id)
    task = module._turn_tasks.get(accepted.turn_id)
    if task:
        await task
    assert module._turn_states[accepted.turn_id]['status'] == 'stopped'
    assert work.state()['status'] == 'interrupted'
    assert (project.path / 'index.html').read_text() == '<button>Before</button>'
