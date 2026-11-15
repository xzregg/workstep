import asyncio
import pytest
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from models import Task, Message
from models.fields import utc_now

async def seed_task(current, project, status="succeeded"):
    def seed(_):
        now = utc_now()
        Task.create(id="task-memory",title="北辰发布",cwd=str(project.path),created_at=now,updated_at=now)
        Message.create(id="task-evidence",task="task-memory",step_key="verify",role="assistant",content="北辰发布失败原因是遗漏数据库迁移，修复后必须回归。",run_status=status,position=1,created_at=now,ended_at=now)
    await current.projects.run_db(project.id, seed)

async def test_task_sources_are_scanned_and_revalidated(runtime):
    from services import digital_person_memory as memory
    current, project, _ = runtime
    await seed_task(current, project, "failed")
    await memory.sync_projects(current.projects)
    hits = await memory.recall_projects(current.projects, "local", "")
    assert hits and hits[0]["source_kind"] == "task"
    assert hits[0]["task_id"] == "task-memory"
    assert hits[0]["outcome"] == "failed"
    assert hits[0]["step_key"] == "verify"
    assert await memory.recall_projects(current.projects, "channel:peer", "") == []
    await current.projects.run_db(project.id, lambda _: Message.delete().execute())
    assert await memory.recall_projects(current.projects, "local", "") == []

async def test_running_task_is_not_indexed_until_finished(runtime):
    from services import digital_person_memory as memory
    current, project, _ = runtime
    await seed_task(current, project, "running")
    await memory.sync_projects(current.projects)
    assert await memory.recall_projects(current.projects, "local", "") == []
    await current.projects.run_db(project.id, lambda _: Message.update(run_status="succeeded",ended_at=utc_now()).execute())
    await memory.sync_projects(current.projects)
    assert await memory.recall_projects(current.projects, "local", "")

async def test_prepare_turn_does_not_wait_for_historical_scan(runtime, monkeypatch):
    from services import digital_person_memory as memory
    current, project, _ = runtime
    sid = (await current.main_session())["id"]
    async def forbidden(*args, **kwargs):
        raise AssertionError("foreground scanned history")
    monkeypatch.setattr(memory, "sync_projects", forbidden)
    scope, hits = await memory.prepare_turn(current.projects, project.id, sid, "hello", "request")
    assert scope == "local"

async def test_channel_task_never_reads_owner_memory(runtime):
    from services import digital_person_memory as memory
    current, project, store = runtime
    await seed_task(current, project)
    await current.projects.run_db(project.id, lambda _: Task.update(creator_id="channel:telegram:peer").execute())
    await memory.sync_projects(current.projects)
    assert await memory.recall_projects(current.projects,"local","") == []
    hits = await memory.recall_projects(current.projects,"task:task-memory","")
    assert hits

async def test_empty_failed_execution_retains_error_evidence_and_event_paging(runtime):
    import json
    from services import digital_person_memory as memory, digital_person_memory_index as index
    current, project, _ = runtime
    await seed_task(current,project,"failed")
    def update(_):
        Message.update(content="",events_json=json.dumps([{"type":"error","data":{"message":"数据库迁移缺失"}}])).execute()
    await current.projects.run_db(project.id,update)
    await memory.sync_projects(current.projects)
    hits = await memory.recall_projects(current.projects,"local","")
    assert hits and 'Recorded execution errors' in hits[0]['content']
    rows = await asyncio.to_thread(index.candidates,"local","")
    page = await memory.read_task_events(current.projects,rows[0],limit=1)
    assert page['message_id'] == 'task-evidence'
    assert len(page['events']) >= 1

async def test_task_source_changes_refresh_metadata_and_preserve_forgetting(runtime):
    from services import digital_person_memory as memory, digital_person_memory_index as index
    current, project, _ = runtime
    await seed_task(current,project)
    await current.projects.run_db(project.id,lambda _:Message.update(content="数据库迁移"*250).execute())
    await memory.sync_projects(current.projects)
    rows = await asyncio.to_thread(index.candidates,"local","")
    await asyncio.to_thread(index.forget, rows[-1]['id'])
    assert await memory.recall_projects(current.projects,"local","") == []
    def shorten(_):
        Message.update(content="短文").execute()
        memory.capture_task_message(project.id,Message.get_by_id('task-evidence'))
        Message.update(content="数据库迁移"*250).execute()
        memory.capture_task_message(project.id,Message.get_by_id('task-evidence'))
    await current.projects.run_db(project.id,shorten)
    assert await memory.recall_projects(current.projects,"local","") == []

async def test_slow_task_source_read_does_not_block_event_loop(runtime,monkeypatch):
    import time
    from services import digital_person_memory as memory
    current, project, _ = runtime
    await seed_task(current,project)
    await memory.sync_projects(current.projects)
    original = memory._hydrate_task
    def slow(*args,**kwargs):
        time.sleep(.15)
        return original(*args,**kwargs)
    monkeypatch.setattr(memory,'_hydrate_task',slow)
    request = asyncio.create_task(memory.recall_projects(current.projects,'local',''))
    await asyncio.sleep(.02)
    assert not request.done()
    started = asyncio.get_running_loop().time()
    await asyncio.sleep(.01)
    assert asyncio.get_running_loop().time()-started < .08
    assert await request
