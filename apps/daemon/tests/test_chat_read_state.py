import asyncio
import threading
import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI
from tests.test_chat_session import chat_module
from models.chat_session import ChatMessage
from models.fields import utc_now

@pytest.fixture
async def setup(chat_module,monkeypatch):
    import main
    module,bus,manager,project,store=chat_module
    monkeypatch.setattr(main,'project_manager',manager)
    from api.chat_session import router
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health():return {'ok':True}
    def seed(_):
        a=module.create_session(project.id)['id'];b=module.create_session(project.id)['id']
        for mid,sid,status in [('done',a,'completed'),('busy',a,'running'),('other',b,'completed')]:
            ChatMessage.create(id=mid,session=sid,role='assistant',status=status,created_at=utc_now())
        return a
    sid=await manager.run_db(project.id,seed)
    return app,manager,project,sid

async def test_read_receipt_requires_visible_terminal_message_identity(setup):
    from services.chat_read_state import is_read
    app,manager,project,sid=setup
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        path=f'/api/chat-sessions/{sid}/read?project_id={project.id}'
        assert (await client.post(path,json={'message_id':'busy'})).status_code==409
        assert (await client.post(path,json={'message_id':'other'})).status_code==404
        assert (await client.post(path,json={'message_id':'done'})).status_code==200
        assert (await client.post(path,json={'message_id':'done'})).status_code==200
        assert await manager.run_db(project.id,lambda _:is_read(project.id,ChatMessage.get_by_id('done')))

async def test_read_receipt_slow_database_keeps_health_responsive(setup,monkeypatch):
    from services import chat_read_state
    app,_,project,sid=setup
    entered,release=threading.Event(),threading.Event()
    original=chat_read_state.mark_read
    def slow(*args):entered.set();assert release.wait(3);return original(*args)
    monkeypatch.setattr(chat_read_state,'mark_read',slow)
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        pending=asyncio.create_task(client.post(f'/api/chat-sessions/{sid}/read?project_id={project.id}',json={'message_id':'done'}))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
        finally:release.set()
        assert (await pending).status_code==200


async def test_read_receipt_cannot_cross_project_scope(setup):
    from services.remote_access import ActorSnapshot,actor_context
    app,_,project,sid=setup
    actor=ActorSnapshot(actor_id='u',user_name='u',device_id='d',device_name='d',source='remote_project',project_id='other',access_level='edit')
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
            assert (await client.post(f'/api/chat-sessions/{sid}/read?project_id={project.id}',json={'message_id':'done'})).status_code==403
