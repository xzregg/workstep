from tests.memory_turn_fixture import create_completed_user
import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


async def seed(runtime, texts):
    from models.chat_session import ChatMessage
    from services import digital_person_memory as memory
    current, project, _ = runtime
    _seed_texts.clear()
    _seed_texts.update({f"query-{i}":text for i,text in enumerate(texts)})
    sid = (await current.main_session())["id"]
    def write(_):
        for i, text in enumerate(texts):
            create_completed_user(id=f"query-{i}", session=sid, role="user", status="completed",
                               content=text, created_at=datetime(2026, 10, 2+i, tzinfo=timezone.utc))
        memory.capture_session(sid, "local")
    await current.projects.run_db(project.id, write)
    return current, project, sid


async def extract_seed_knowledge():
    from services import digital_person_memory_index as index, memory_knowledge as knowledge
    rows=await asyncio.to_thread(index.candidates,'local')
    def store():
        for row in rows:
            if row['role']!='user':continue
            text=_seed_texts.get(row['source_message_id'],'测试知识')
            knowledge.store_extraction({'memories':[{'summary':text[:1200], 'kind':'fact',
                'outcome':'stated','source_ids':['memory:'+str(row['id'])]}]},rows)
    await asyncio.to_thread(store)


_seed_texts={}


async def test_search_pagination_read_and_source_changes(runtime):
    from services import memory_query as query
    from models.chat_session import ChatMessage
    current, project, sid = await seed(runtime, ["天文摄影计划" * 200, "天文摄影已经完成", "天文摄影需要改进"])
    token = await query.create_context(current.projects, "local", session_id=sid)
    await extract_seed_knowledge()
    first = await query.search(current.projects, token, query="天文摄影", limit=3)
    assert len(first['knowledge'])==3 and first['items']==[]
    source=first['knowledge'][0]['sources'][0]
    read = await query.read(current.projects, token, source['id'], limit=10)
    assert len(read['content'])==10
    await current.projects.run_db(project.id, lambda _: ChatMessage.delete().where(ChatMessage.id == read['source_message_id']).execute())
    with pytest.raises(LookupError):
        await query.read(current.projects, token, source['id'])


async def test_reading_state_respects_project_access_and_expires(runtime, tmp_path, monkeypatch):
    from services import memory_query as query
    from services.remote_access import ActorSnapshot, actor_context
    current, project, sid = await seed(runtime, ["天文摄影秘密"])
    other = await asyncio.to_thread(current.projects.init_project, tmp_path / "other")
    channel_token = await query.create_context(current.projects, "channel:private", session_id="")
    assert not (await query.search(current.projects, channel_token, query="天文摄影"))["items"]
    token = await query.create_context(current.projects, "local", session_id=sid)
    actor = ActorSnapshot("u", "u", "d", "d", "remote", project_id=other.id, access_level="read")
    with actor_context(actor):
        result=await query.search(current.projects,token,query="天文摄影")
        assert not result["items"] and not result["knowledge"]
    with pytest.raises(PermissionError):
        await query.search(current.projects, "fake", query="天文摄影")
    monkeypatch.setattr(query.time, "monotonic", lambda: 10**15)
    with pytest.raises(PermissionError):
        await query.search(current.projects, token, query="天文摄影")


async def test_read_coverage_requires_contiguous_pages_of_the_same_chunk_version(runtime):
    from services import memory_query as query, digital_person_memory_index as index
    current, project, sid = await seed(runtime, ['新的消息内容'*200])
    token=await query.create_context(current.projects,'local',session_id=sid)
    with index.connect() as db:
        rows=[dict(r) for r in db.execute("SELECT * FROM memories WHERE project_id=? AND role='user' ORDER BY offset",(project.id,))]
    requirements=[{**r,'id':'memory:'+str(r['id']),'length':800} for r in rows[:1]]
    mid=requirements[0]['id']
    assert query.observed_sources(token,requirements)==[]
    await query.read(current.projects,token,mid,offset=0,limit=300)
    await query.read(current.projects,token,mid,offset=400,limit=400)
    assert query.observed_sources(token,requirements)==[]
    await query.read(current.projects,token,mid,offset=300,limit=100)
    assert query.observed_sources(token,requirements)==[mid]
    assert query.observed_sources(token,[{**requirements[0],'source_hash':'stale'}])==[]


def test_last_month_uses_calendar_timezone():
    from services.memory_query import time_range
    start, end = time_range(period="上月", timezone_name="Asia/Shanghai", now=datetime(2026, 11, 1, tzinfo=timezone.utc))
    assert start == "2026-09-30T16:00:00+00:00"
    assert end == "2026-10-31T16:00:00+00:00"


async def test_history_pages_all_indexed_sources_and_reports_coverage(runtime):
    from services import memory_query as query
    current, project, sid = await seed(runtime, ["计划部署", "部署完成", "部署回归通过"])
    token = await query.create_context(current.projects, "local", session_id=sid)
    rows, cursor, snapshot = [], 0, ""
    while True:
        page = await query.history(current.projects, token, since="2026-10-01T00:00:00Z", before="2026-11-01T00:00:00Z", limit=1, cursor=cursor, snapshot=snapshot)
        rows.extend(page["items"])
        assert page["coverage"]["basis"] == "authoritative_terminal_messages"
        if not page["has_more"]:
            break
        cursor, snapshot = page["next_cursor"], page["snapshot"]
    assert len(rows) == 6
    assert page["coverage"]["complete_source_history"]


async def test_api_requires_token_and_slow_index_does_not_block_health(runtime, monkeypatch):
    import threading
    from services import memory_query as query
    from api import memory
    current, project, sid = await seed(runtime, ["天文摄影"])
    token = await query.create_context(current.projects, "local", session_id=sid)
    monkeypatch.setattr(memory, "projects", lambda: current.projects)
    app = FastAPI(); app.include_router(memory.router)
    @app.get("/health")
    async def health(): return {"ok": True}
    entered, release = threading.Event(), threading.Event()
    from services import memory_knowledge
    await extract_seed_knowledge()
    original = memory_knowledge._candidates
    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)
    monkeypatch.setattr(memory_knowledge, "_candidates", slow)
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        assert (await client.post("/api/memory/search", json={"filter_project_id": "fake"})).status_code == 403
        pending = asyncio.create_task(client.post("/api/memory/search", json={"query": "天文摄影"}))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get("/health"), .3)).status_code == 200
        finally:
            release.set()
        response = await pending
        assert response.status_code == 200 and response.json()["knowledge"]


async def test_forgotten_chunk_cannot_be_recovered_through_other_chunk(runtime):
    from services import memory_query as query, digital_person_memory_index as index
    current, project, sid = await seed(runtime, ["天文摄影" * 600])
    token = await query.create_context(current.projects, "local", session_id=sid)
    rows=await asyncio.to_thread(index.candidates,'local')
    assert len(rows)==2
    mid='memory:'+str(rows[0]['id'])
    await asyncio.to_thread(index.forget,mid)
    with pytest.raises(LookupError):
        await query.read(current.projects,token,mid,limit=6000)


async def test_disabling_memory_revokes_existing_token(runtime, monkeypatch):
    from services import memory_query as query, digital_person
    current, project, sid = await seed(runtime, ["天文摄影"])
    token = await query.create_context(current.projects, "local", session_id=sid)
    monkeypatch.setattr(digital_person, "get_profile", lambda: digital_person.DigitalPersonProfile(enabled=False))
    with pytest.raises(PermissionError):
        await query.search(current.projects, token)


async def test_snapshot_pagination_survives_source_deletion(runtime):
    from services import memory_query as query, digital_person_memory_index as index
    current, project, sid = await seed(runtime, ["分页第一个", "分页第二个", "分页第三个"])
    token = await query.create_context(current.projects, "local", session_id=sid)
    first = await query.history(current.projects, token, limit=2, include_knowledge=False)
    await asyncio.to_thread(index.delete_source, project.id, first["items"][0]["source_message_id"])
    second = await query.history(current.projects, token, limit=2, cursor=first["next_cursor"], snapshot=first["snapshot"], include_knowledge=False)
    assert second["items"][0]["content"] == "分页第二个"
    third = await query.history(current.projects, token, limit=2, cursor=second["next_cursor"], snapshot=first["snapshot"], include_knowledge=False)
    assert third["items"][0]["content"] == "分页第三个"
    with pytest.raises(ValueError):
        await query.search(current.projects, token, query="不同查询", snapshot=first["snapshot"], include_knowledge=False)


async def test_history_reads_cold_unindexed_sources_across_projects(runtime, tmp_path):
    from services import memory_query as query, digital_person_memory_index as index
    from models.chat_session import ChatMessage
    current, project, sid = await seed(runtime, ["已索引资料"])
    other = await asyncio.to_thread(current.projects.init_project, tmp_path / "cold")
    def cold(_):
        other_sid = current.chats.create_session(other.id)["id"]
        for i in range(15):
            ChatMessage.create(id=f"cold-{i:02}", session=other_sid, role="assistant", status="completed",
                               content=f"上月执行完成第{i}件工作", created_at=datetime(2026, 10, 3, tzinfo=timezone.utc))
    await current.projects.run_db(other.id, cold)
    token = await query.create_context(current.projects, "local", session_id=sid)
    items, cursor, snapshot = [], 0, ""
    for _ in range(20):
        page = await query.history(current.projects, token, since="2026-10-01", before="2026-11-01", limit=3, cursor=cursor, snapshot=snapshot)
        items.extend(page["items"])
        if not page["has_more"]:
            break
        cursor, snapshot = page["next_cursor"], page["snapshot"]
    assert len(items) == 17
    assert len({row["source_message_id"] for row in items}) == 17
    assert page["coverage"]["complete_source_history"]
    assert {row["project_id"] for row in items} == {project.id, other.id}


async def test_normal_query_does_not_infer_scope_from_channel_binding(runtime):
    from services import memory_query as query
    current,project,sid=await seed(runtime,["天文摄影私人记忆"])
    context=query.query_access(current.projects)
    runtime[2].set('channel_bots',{'sessions':{'private-peer':sid}})
    result=await query.search(current.projects,context)
    assert any('天文摄影' in item['content'] for item in result['items'])


async def test_history_preserves_long_sources_and_explicit_read_pages(runtime):
    from services import memory_query as query
    current, project, sid = await seed(runtime, ["部署计划" * 2000 + "最后实际失败"])
    token = await query.create_context(current.projects, "local", session_id=sid)
    result = await query.history(current.projects, token)
    hit = next(item for item in result["items"] if item["role"]=="user")
    assert not hit["needs_read"] and hit["content"].endswith("最后实际失败")
    tail = await query.read(current.projects, token, hit["id"], offset=8000)
    assert tail["content"].endswith("最后实际失败")


def test_memory_instruction_only_supplies_execution_credential():
    from services.memory_query import instruction
    text = instruction()
    assert text == ''


async def test_channel_history_does_not_scan_private_sources_or_leak_counts(runtime):
    from models.chat_session import ChatMessage
    from services import memory_query as query
    current, project, private_sid = await seed(runtime, ["私人消息" for _ in range(20)])
    def make_channel(_):
        sid = current.chats.create_session(project.id)["id"]
        create_completed_user(id="channel-public", session=sid, role="user", status="completed",
                           content="渠道可见消息", created_at=datetime(2026, 10, 3, tzinfo=timezone.utc))
        return sid
    sid = await current.projects.run_db(project.id, make_channel)
    runtime[2].set("channel_bots", {"sessions": {"peer": sid}})
    token = await query.create_context(current.projects, "channel:peer", session_id=sid, issuer_project_id=project.id)
    page = await query.history(current.projects, token, limit=3)
    assert [item["content"] for item in page["items"]] == ["渠道可见消息","已收到。"]
    assert not page["has_more"]
    assert page["coverage"]["scanned_sources"] == 2
    assert page["coverage"]["excluded_sources"] == 0


async def test_task_history_does_not_scan_other_private_tasks(runtime):
    from models import Task, Message
    from services import memory_query as query
    current, project, sid = await seed(runtime, ["私人聊天" for _ in range(20)])
    def make_tasks(_):
        now = datetime(2026, 10, 3, tzinfo=timezone.utc)
        Task.create(id="public-task", title="渠道任务", cwd=str(project.path), creator_id="channel:peer", created_at=now, updated_at=now)
        Task.create(id="private-task", title="私人任务", cwd=str(project.path), created_at=now, updated_at=now)
        Message.create(id="public-source", task="public-task", step_key="test", role="assistant", content="渠道任务结果", run_status="succeeded", position=1, created_at=now)
        for i in range(20):
            Message.create(id=f"private-source-{i}", task="private-task", step_key="test", role="assistant", content="私人任务结果", run_status="succeeded", position=i, created_at=now)
    await current.projects.run_db(project.id, make_tasks)
    token = await query.create_context(current.projects, "task:public-task", session_id="public-task", issuer_kind="task", issuer_project_id=project.id)
    page = await query.history(current.projects, token, limit=2)
    assert len(page["items"]) == 1 and page["items"][0]["task_id"] == "public-task"
    assert not page["has_more"]
    assert page["coverage"]["scanned_sources"] == 1
    assert page["coverage"]["excluded_sources"] == 0
