"""Host ownership is independent of the transport's authentication principal."""

import pytest

from services.config import config_store
from services.remote_access import ActorSnapshot, actor_context, get_current_actor, get_effective_actor, replayed_actor_context


def configure_host(*, gateway=False):
    config_store.set_user_name('谢钊荣')
    config_store.set('device', {'device_id': 'host-device', 'device_name': '工作电脑'})
    config_store.set('gateway_platform', {'enabled': gateway, 'url': 'https://gateway.test'})
    config_store.sync_gateway_user(name='谢钊荣', username='xiezhaorong',
                                   gateway_id='gateway-user', origin='https://gateway.test')


@pytest.mark.parametrize('gateway', [True, False])
def test_host_workspace_uses_one_identity_without_replacing_authentication(gateway):
    from services.remote_access import host_attribution_context, get_host_actor
    from services.messages import current_actor_message_fields, current_actor_task_fields
    configure_host(gateway=gateway)
    host = get_host_actor()
    expected_id = 'gateway-user' if gateway else 'host-device'
    for raw in (
        ActorSnapshot('old-browser', '残留名', 'browser-device', 'Chrome', 'browser'),
        ActorSnapshot('webrtc-p2p', 'P2P Remote', 'host-device', '工作电脑', 'remote', access_source='webrtc_p2p'),
    ):
        with actor_context(raw), host_attribution_context(host):
            assert get_current_actor() is raw
            assert get_effective_actor().actor_id == expected_id
            fields = current_actor_message_fields()
            assert fields['author_id'] == expected_id
            assert fields['author_name'] == '谢钊荣'
            assert fields['identity_source'] == ('gateway' if gateway else 'local')
            assert fields['access_source'] == (raw.access_source or 'local')
            assert current_actor_task_fields()['creator_id'] == expected_id
            # Recovery must use its snapshot, even inside a host request.
            with replayed_actor_context(raw):
                assert get_effective_actor() is raw
            with replayed_actor_context(None):
                assert get_effective_actor() is None


def test_unverified_or_other_gateway_never_becomes_local_owner():
    from services.remote_access import get_host_actor
    configure_host(gateway=True)
    config_store.set('gateway_platform', {'enabled': True, 'url': 'https://other.test'})
    assert get_host_actor() is None


def test_gateway_disconnect_keeps_name_but_uses_local_identity():
    from services.remote_access import get_host_actor
    configure_host(gateway=True)
    assert get_host_actor().actor_id == 'gateway-user'
    config_store.set('gateway_platform', {'enabled': False})
    assert (get_host_actor().actor_id, get_host_actor().user_name) == ('host-device', '谢钊荣')


def test_pending_insert_replays_saved_owner_after_host_account_changes(tmp_path):
    from models import init_db
    from services.pending_message_inserts import create_pending_insert, pending_insert_actor
    from services.remote_access import get_host_actor, host_attribution_context
    configure_host(gateway=True)
    db = init_db(str(tmp_path / 'pending.db'))
    try:
        raw = ActorSnapshot('webrtc-p2p', '旧名字', 'host-device', '设备', 'remote', access_source='webrtc_p2p')
        with actor_context(raw), host_attribution_context(get_host_actor()):
            create_pending_insert('target-message', '稍后继续', None)
        config_store.sync_gateway_user(name='另一个人', username='other', gateway_id='other-user', origin='https://gateway.test')
        saved = pending_insert_actor('target-message')
        with replayed_actor_context(saved):
            actor = get_effective_actor()
            assert (actor.actor_id, actor.user_name) == ('gateway-user', '谢钊荣')
            assert (actor.identity_source, actor.access_source) == ('gateway', 'webrtc_p2p')
    finally:
        db.close()


def test_non_host_gateway_visitors_and_channels_keep_their_own_identity():
    configure_host(gateway=True)
    for actor in (
        ActorSnapshot('other-user', '谢钊荣', 'visitor', '浏览器', 'managed'),
        ActorSnapshot('channel:wechat:other', '谢钊荣', 'bot', '微信', 'channel'),
        ActorSnapshot('lan-visitor', '谢钊荣', 'visitor', '浏览器', 'browser', access_source='remote_browser'),
    ):
        with actor_context(actor):
            assert get_effective_actor() is actor


@pytest.mark.asyncio
@pytest.mark.parametrize('gateway', [True, False])
async def test_native_and_p2p_http_boundaries_save_the_same_owner(monkeypatch, gateway):
    from types import SimpleNamespace
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from api.desktop_security import DesktopSecurityMiddleware
    from api.remote_access_guard import BrowserActorMiddleware
    from api.system_settings import router as settings_router
    from services.gateway_client.identity import ManagedActor, ManagedLocalSessions
    from services.webrtc_p2p.bridge import WebRtcRemoteActor
    from services.messages import current_actor_message_fields, current_actor_task_fields
    configure_host(gateway=gateway)
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'test-desktop-token')
    app = FastAPI()
    app.include_router(settings_router)
    app.state.gateway_client = SimpleNamespace(
        managed_config=SimpleNamespace(gateway_origin='https://gateway.test') if gateway else None,
        current_actor=ManagedActor('gateway-user', 'xiezhaorong', 'host-device', 'instance', 1, display_name='谢钊荣'),
        local_sessions=ManagedLocalSessions(),
    )
    app.state.webrtc_scope_token = object()
    app.add_middleware(DesktopSecurityMiddleware)
    app.add_middleware(BrowserActorMiddleware)

    @app.middleware('http')
    async def trusted_bridge(request, call_next):
        if request.url.path.endswith('/p2p') or request.query_params.get('transport') == 'p2p':
            request.scope.update(webrtc_remote_actor=WebRtcRemoteActor('webrtc-p2p', 'webrtc-p2p', 'host-device'),
                                 webrtc_bridge_token=app.state.webrtc_scope_token, webrtc_device_owner=True)
        return await call_next(request)

    @app.get('/api/attribution/{transport}')
    async def attribution(transport: str):
        return {'message': current_actor_message_fields(), 'task': current_actor_task_fields(),
                'authentication_id': get_current_actor().actor_id}

    @app.post('/api/task/create/p2p')
    async def create():
        return current_actor_task_fields()

    headers = {'X-WorkStep-Actor-Id': 'leftover-browser', 'X-WorkStep-Actor-Name': 'old-name',
               'X-WorkStep-Actor-Device-Id': 'browser-device', 'X-WorkStep-Actor-Device-Name': 'Chrome'}
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://localhost') as client:
        local = await client.get('/api/attribution/local', headers={**headers, 'X-WorkStep-Desktop-Token': 'test-desktop-token'})
        p2p = await client.get('/api/attribution/p2p', headers=headers)
        settings = (await client.get('/api/system-settings?transport=p2p')).json()
        assert settings['identity_source'] == ('gateway' if gateway else 'local')
        assert settings['user_name'] == '谢钊荣'
        if gateway:
            config_store.set('gateway_platform', {'enabled': True, 'url': 'https://another.test'})
            assert (await client.post('/api/task/create/p2p', headers=headers)).status_code == 401
    assert local.status_code == p2p.status_code == 200
    expected = 'gateway-user' if gateway else 'host-device'
    for result in (local.json(), p2p.json()):
        assert result['message']['author_id'] == result['task']['creator_id'] == expected
        assert result['message']['author_name'] == '谢钊荣'
    assert p2p.json()['message']['access_source'] == 'webrtc_p2p'
    assert p2p.json()['authentication_id'] == 'webrtc-p2p'


@pytest.mark.asyncio
async def test_review_usage_upload_uses_saved_message_initiator(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    import main
    from models import init_db, Message, Task
    from models.fields import utc_now
    from services.review_messages import StepReviewMessages
    db = init_db(str(tmp_path / 'attribution.db'))
    try:
        now = utc_now()
        task = Task.create(id='task', title='原创建人任务', cwd=str(tmp_path), creator_id='creator', created_at=now, updated_at=now)
        Message.create(id='review-call', task=task, step_key='do', role='assistant', position=0,
                       initiated_by_user_id='actual-initiator', created_at=now)
        upload = AsyncMock()
        monkeypatch.setattr(main.gateway_client, 'record_message_usage', upload)
        async def run_db(operation):
            return await asyncio.to_thread(operation)
        service = SimpleNamespace(_run_db=run_db, _project_id='project')
        outcome = SimpleNamespace(review_run=SimpleNamespace(engine='codex', step_run_id='step', model='model', ended_at=now),
                                  provider=None, provider_id=None)
        await StepReviewMessages._record_usage(service, task, 'review-call', outcome, '{"total_tokens":1}')
        assert upload.await_args.kwargs['user_id'] == 'actual-initiator'
    finally:
        db.close()
