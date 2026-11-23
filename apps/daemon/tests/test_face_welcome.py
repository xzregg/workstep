from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from tests.test_face_recognition import faces, person


def test_only_one_offer_and_no_identity_or_text_in_receipt(faces, monkeypatch):
    from services import face_welcome, digital_person
    from services.digital_person_memory_index import read_state
    monkeypatch.setattr(digital_person, 'get_profile', lambda: digital_person.DigitalPersonProfile(
        enabled=True, quiet_start=0, quiet_end=0))
    p = person(faces)
    assert not face_welcome.settings().enabled
    face_welcome.save(face_welcome.Settings(enabled=True, phrases=['你好，{name}，我的{relationship}。']))
    now = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
    rev = faces.revision()['revision']
    def offer(i):
        return face_welcome.offer(face_welcome.Candidate(
            event_id=str(i), revision=rev, person_id=p['id']), now=now)
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(offer, [1, 2]))
    assert [r.text for r in results if r] == ['你好，小张，我的朋友。']
    assert not offer(1)
    assert not offer(2)
    assert '小张' not in str(read_state(face_welcome.RECEIPTS))
    assert face_welcome.settings().phrases == ['你好，{name}，我的{relationship}。']
    assert face_welcome.blocks_social({}, None, now + timedelta(minutes=1))
    faces.update(p['id'], faces.PersonEdit(name=p['name'], relationship=p['relationship'], enabled=False))
    assert not face_welcome.offer(face_welcome.Candidate(
        event_id='3', revision=rev, person_id=p['id']), now=now + timedelta(days=1))


@pytest.mark.parametrize('policy_mode', ['missing', 'old_denial'])
async def test_host_routes_and_disabled_offer(faces, monkeypatch, policy_mode):
    import main
    from api.digital_person import router
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from services.remote_access import ActorSnapshot, actor_context
    from services.gateway_client.policy import ManagedPolicyCache, verify_policy_snapshot
    from tests.test_gateway_policy import _signed_policy

    cache = ManagedPolicyCache()
    if policy_mode == 'old_denial':
        token, pem, fingerprint = _signed_policy(allow_local_providers=False)
        cache.apply(verify_policy_snapshot(token, pem, fingerprint, 'gateway-test', 'device-1', 'user-1'))
    monkeypatch.setattr(main, 'gateway_client', SimpleNamespace(managed_config=object(), policy_cache=cache))
    app = FastAPI()
    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        base = '/api/digital-person/faces/welcome'
        assert (await client.get(base)).json()['enabled'] is False
        with actor_context(ActorSnapshot('user-1', 'Alice', 'device-1', 'PC', 'managed')):
            assert (await client.put(base, json={'enabled': True})).status_code == 200
            assert (await client.get(base)).json()['enabled'] is True
        actor = ActorSnapshot(actor_id='u', user_name='u', device_id='d', device_name='d',
                              source='remote_project', project_id='p', access_level='edit')
        with actor_context(actor):
            for method, suffix in [('GET', ''), ('PUT', ''), ('POST', '/offer')]:
                assert (await client.request(method, base+suffix, json={})).status_code == 403


async def test_offer_http_checks_busy_and_keeps_async_health_available(faces, monkeypatch):
    import asyncio
    import threading

    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from api import digital_person as api
    from services import digital_person, face_welcome
    from services.digital_person_memory_index import connect

    class Runtime:
        busy = True

        async def face_welcome_activity(self):
            return None, self.busy

    runtime = Runtime()
    monkeypatch.setattr(api, 'runtime', lambda: runtime)
    monkeypatch.setattr(digital_person, 'get_profile', lambda: digital_person.DigitalPersonProfile(
        enabled=True, quiet_start=0, quiet_end=0))
    monkeypatch.setattr(face_welcome, 'choice', lambda phrases: phrases[-1])
    app = FastAPI()
    app.include_router(api.router)

    @app.get('/health')
    async def health():
        return {'ok': True}

    p = person(faces)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        base = '/api/digital-person/faces/welcome'
        config = {'enabled': True, 'output': 'voice', 'phrases': ['你好。', '欢迎，{name}（{relationship}）。']}
        assert (await client.put(base, json=config)).status_code == 200
        candidate = {'event_id': 'busy-1', 'revision': faces.revision()['revision'], 'person_id': p['id']}
        assert (await client.post(base+'/offer', json=candidate)).json() is None
        runtime.busy = False
        entered, release = threading.Event(), threading.Event()

        def hold():
            with connect():
                entered.set()
                assert release.wait(3)

        holder = asyncio.create_task(asyncio.to_thread(hold))
        assert await asyncio.to_thread(entered.wait, 2)
        pending = asyncio.create_task(client.post(base+'/offer', json=candidate))
        try:
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
            await asyncio.sleep(.02)
            assert not pending.done()
        finally:
            release.set()
        await holder
        assert (await pending).json() == {'text': '欢迎，小张（朋友）。', 'speak': True, 'personalized': True}
        assert (await client.post(base+'/offer', json=candidate)).json() is None


def test_person_and_rolling_global_limits_and_quiet_hours(faces, monkeypatch):
    from services import face_welcome, digital_person

    profile = digital_person.DigitalPersonProfile(enabled=True, quiet_start=0, quiet_end=0)
    monkeypatch.setattr(digital_person, 'get_profile', lambda: profile)
    a = person(faces)['id']
    b = faces.create(faces.Enrollment(name='小林', relationship='同事', consent=True,
        embeddings=[[.1]*1024]*3))['id']
    c = faces.create(faces.Enrollment(name='小安', relationship='伙伴', consent=True,
        embeddings=[[.1]*1024]*3))['id']
    face_welcome.save(face_welcome.Settings(enabled=True))
    rev = faces.revision()['revision']
    base = datetime(2026, 1, 1, 12).astimezone()
    sequence = iter(range(10))

    def attempt(pid, minutes, reply=True):
        now = base + timedelta(minutes=minutes)
        last_user = {'role': 'user', 'id': str(minutes), 'created_at': now-timedelta(minutes=2)} if reply else None
        return face_welcome.offer(face_welcome.Candidate(
            event_id=str(next(sequence)), revision=rev, person_id=pid), last_user, now=now)

    assert attempt(a, 0)
    assert not attempt(b, 11, reply=False)
    assert not attempt(a, 15)
    assert attempt(b, 16)
    assert not attempt(c, 29)
    assert attempt(a, 61)
    profile.quiet_start, profile.quiet_end = 13, 15
    assert not attempt(c, 80)


async def test_offer_reads_foreground_chat_on_database_worker(runtime, monkeypatch):
    import asyncio
    import threading

    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from api import digital_person as api
    from models.chat_session import ChatMessage

    current, project, _ = runtime
    session = (await current.main_session())['id']
    await current.projects.run_db(project.id, lambda _: ChatMessage.create(
        id='working', session=session, role='assistant', status='running', content='', created_at=datetime.now(timezone.utc)))
    monkeypatch.setattr(api, 'runtime', lambda: current)
    app = FastAPI()
    app.include_router(api.router)

    @app.get('/health')
    async def health():
        return {'ok': True}

    select = ChatMessage.select
    loop_thread = threading.get_ident()
    entered, release = threading.Event(), threading.Event()

    def slow_select(*args):
        assert threading.get_ident() != loop_thread
        entered.set()
        assert release.wait(3)
        return select(*args)

    monkeypatch.setattr(ChatMessage, 'select', staticmethod(slow_select))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        pending = asyncio.create_task(client.post('/api/digital-person/faces/welcome/offer', json={
            'event_id': 'example', 'revision': 0, 'person_id': 'example'}))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
        finally:
            release.set()
        response = await pending
        assert response.status_code == 200
        assert response.json() is None
