"""Third-party callback allowlist and single-use request-bound login codes."""
import asyncio
import secrets
import sqlite3
import threading
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event

from gateway.app import create_app
from gateway.config import GatewaySettings
from test_external_identity import _setup, _source, FakeConnector

CALLBACK = 'http://business.example.com:8080/login/callback?tenant=demo'
SETTINGS = '/api/admin/third-party-auth-settings'
AUTHORIZE = '/api/auth/third-party/authorize'


@pytest.fixture
def actor(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_rate_limiter.limit = 100
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        headers = {'X-CSRF-Token': csrf}
        assert client.post('/api/auth/step-up', headers=headers,
                           json={'password': 'OwnerPassphrase-2026!'}).status_code == 200
        yield app, client, headers


def configure(client, headers, urls=None):
    response = client.put(SETTINGS, headers=headers, json={'callback_urls': urls if urls is not None else [CALLBACK]})
    assert response.status_code == 200, response.text


def issue(client, headers, **overrides):
    body = {'callback': CALLBACK, 'state': secrets.token_urlsafe(24), 'request_id': secrets.token_urlsafe(32)}
    body.update(overrides)
    response = client.post(AUTHORIZE, headers=headers, json=body)
    assert response.status_code == 200, response.text
    target = urlsplit(response.json()['callback_url'])
    params = parse_qs(target.query)
    assert params['state'] == [body['state']]
    assert params['tenant'] == ['demo']
    assert 'request_id' not in params
    assert response.headers['cache-control'] == 'no-store'
    return params['code'][0], body['request_id']


def test_settings_permissions_and_validation(actor, tmp_path):
    app, client, headers = actor
    assert client.get(SETTINGS).json() == {'callback_urls': []}
    assert client.put(SETTINGS, json={'callback_urls': [CALLBACK]}).status_code == 403
    configure(client, headers, [CALLBACK, 'https://business.example.com/callback'])
    for invalid in ['javascript:alert(1)', '//evil.test/callback', 'https://user:pass@evil.test/callback',
                    'https://evil.test/callback#fragment', 'https://*.test/callback',
                    'https://evil.test/callback?code=x', 'https://evil.test/callback?%73tate=x',
                    'https://evil.test/\\evil', 'https://evil.test/callback\r\n',
                    'https://evil.test:99999/callback']:
        assert client.put(SETTINGS, headers=headers, json={'callback_urls': [invalid]}).status_code == 422
    with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
        assert db.execute("SELECT count(*) FROM audit_events WHERE action='admin.third_party_auth_changed'").fetchone()[0] == 1
    client.cookies.clear()
    assert client.get(SETTINGS).status_code == 401
    assert client.post('/api/auth/login', json={'username':'owner', 'password':'OwnerPassphrase-2026!'}).status_code == 200
    csrf = client.get('/api/auth/session').json()['csrf_token']
    assert client.put(SETTINGS, headers={'X-CSRF-Token': csrf}, json={'callback_urls': []}).status_code == 403
    assert app.state.database.head_revision == '0051_third_party_auth'


def test_allowlist_persists(tmp_path):
    settings = GatewaySettings(data_dir=tmp_path)
    with TestClient(create_app(settings), base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client)}
        client.post('/api/auth/step-up', headers=headers, json={'password':'OwnerPassphrase-2026!'})
        configure(client, headers)
    with TestClient(create_app(settings), base_url='https://gateway.test') as client:
        login = client.post('/api/auth/login', json={'username':'owner','password':'OwnerPassphrase-2026!'})
        assert login.status_code == 200
        assert client.get(SETTINGS).json() == {'callback_urls': [CALLBACK]}


def test_exchange_requires_matching_request_and_is_cookie_free_single_use(actor, tmp_path):
    _, client, headers = actor
    configure(client, headers)
    code, request_id = issue(client, headers)
    with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
        stored = db.execute('SELECT code_hash, request_id_hash FROM third_party_auth_codes').fetchone()
        assert code not in stored and request_id not in stored
    client.cookies.clear()
    assert client.post('/api/auth/exchange', json={'code':code, 'request_id':secrets.token_urlsafe(32)}).status_code == 400
    result = client.post('/api/auth/exchange', json={'code':code, 'request_id':request_id})
    assert result.status_code == 200, result.text
    assert set(result.json()['user']) == {'id', 'username', 'display_name'}
    assert result.json()['user']['username'] == 'owner'
    assert result.headers['cache-control'] == 'no-store'
    assert 'set-cookie' not in result.headers
    assert client.post('/api/auth/exchange', json={'code':code, 'request_id':request_id}).status_code == 400


def test_authorization_requires_session_csrf_and_exact_callback(actor):
    _, client, headers = actor
    body = {'callback': CALLBACK, 'state':'login-state', 'request_id':secrets.token_urlsafe(32)}
    assert client.post(AUTHORIZE, headers=headers, json=body).status_code == 403
    configure(client, headers)
    assert client.post(AUTHORIZE, json=body).status_code == 403
    for callback in [CALLBACK.replace('http:', 'https:'), CALLBACK.replace('8080', '8081'),
                     CALLBACK.replace('/login/', '/other/'), CALLBACK.replace('tenant=demo', 'tenant=other'),
                     CALLBACK.replace('business.example.com', 'sub.business.example.com')]:
        assert client.post(AUTHORIZE, headers=headers, json={**body, 'callback':callback}).status_code == 403
    client.cookies.clear()
    assert client.post(AUTHORIZE, headers=headers, json=body).status_code == 401


@pytest.mark.parametrize('failure', ['expired', 'disabled', 'removed'])
def test_exchange_rechecks_expiry_user_and_allowlist(actor, tmp_path, failure):
    _, client, headers = actor
    configure(client, headers)
    code, request_id = issue(client, headers)
    if failure == 'removed':
        configure(client, headers, [])
    else:
        with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
            db.execute("UPDATE third_party_auth_codes SET expires_at='2000-01-01'" if failure == 'expired'
                       else "UPDATE users SET status='disabled' WHERE username='owner'")
    assert client.post('/api/auth/exchange', json={'code':code, 'request_id':request_id}).status_code == (403 if failure == 'disabled' else 400)


def test_concurrent_exchange_only_succeeds_once(actor):
    app, client, headers = actor
    configure(client, headers)
    code, request_id = issue(client, headers)
    async def scenario():
        async with AsyncClient(transport=ASGITransport(app), base_url='https://gateway.test') as remote:
            results = await asyncio.gather(*(remote.post('/api/auth/exchange', json={'code':code,'request_id':request_id}) for _ in range(2)))
            assert sorted(result.status_code for result in results) == [200, 400]
    client.portal.call(scenario)


def test_ordinary_user_cannot_manage_third_party_settings(actor):
    _, client, headers = actor
    assert client.put('/api/admin/registration-policy', headers=headers, json={'mode':'open'}).status_code == 200
    registered = client.post('/api/auth/register', json={'username':'alice','display_name':'Alice','password':'AlicePassphrase-2026!'})
    assert registered.status_code == 201
    csrf = client.get('/api/auth/session').json()['csrf_token']
    assert client.get(SETTINGS).status_code == 403
    assert client.put(SETTINGS, headers={'X-CSRF-Token':csrf}, json={'callback_urls':[CALLBACK]}).status_code == 403


def test_readding_callback_does_not_revive_old_codes(actor):
    _, client, headers = actor
    configure(client, headers)
    code, request_id = issue(client, headers)
    configure(client, headers, [])
    configure(client, headers)
    assert client.post('/api/auth/exchange', json={'code':code,'request_id':request_id}).status_code == 400


def test_exchange_validation_and_rate_limit_are_not_cached(actor):
    app, client, _ = actor
    response = client.post('/api/auth/exchange', json={'code':'unknown'})
    assert response.status_code == 422
    assert response.headers['cache-control'] == 'no-store'
    app.state.identity_rate_limiter.limit = 1
    body = {'code':'unknown','request_id':secrets.token_urlsafe(32)}
    assert client.post('/api/auth/exchange', json=body).status_code == 400
    response = client.post('/api/auth/exchange', json=body)
    assert response.status_code == 429
    assert response.headers['cache-control'] == 'no-store'


def test_scan_login_preserves_third_party_context(actor):
    app, client, headers = actor
    configure(client, headers)
    source = _source(client, headers['X-CSRF-Token'])
    app.state.identity_connectors = {'dingtalk': FakeConnector()}
    next_path = '/auth/authorize?callback=http%3A%2F%2Fbusiness.example.com%3A8080%2Flogin%2Fcallback%3Ftenant%3Ddemo&state=browser-state&request_id=' + secrets.token_urlsafe(32)
    from urllib.parse import quote
    return_to = '/auth?next=' + quote(next_path, safe='')
    client.cookies.clear()
    started = client.post(f'/api/auth/external/{source}/start', json={'return_to':return_to})
    state = parse_qs(urlsplit(started.json()['authorization_url']).query)['state'][0]
    callback = client.get(f'/api/auth/external/{source}/callback', params={'state':state,'code':'valid-code'}, follow_redirects=False)
    assert callback.headers['location'] == return_to
    session = client.get('/api/auth/session').json()
    body = {key: values[0] for key, values in parse_qs(urlsplit(next_path).query).items()}
    authorized = client.post(AUTHORIZE, headers={'X-CSRF-Token':session['csrf_token']}, json=body)
    assert authorized.status_code == 200, authorized.text


def test_pending_scan_account_preserves_authorization_destination(actor, tmp_path):
    app, client, headers = actor
    source = _source(client, headers['X-CSRF-Token'])
    app.state.identity_connectors = {'dingtalk': FakeConnector()}
    client.cookies.clear()
    started = client.post(f'/api/auth/external/{source}/start')
    state = parse_qs(urlsplit(started.json()['authorization_url']).query)['state'][0]
    first = client.get(f'/api/auth/external/{source}/callback', params={'state':state,'code':'valid-code'})
    user_id = first.json()['user']['id']
    with sqlite3.connect(tmp_path/'workstep_platform.db') as db:
        db.execute("UPDATE users SET status='pending' WHERE id=?", (user_id,))
    client.cookies.clear()
    next_path = '/auth/authorize?callback=http%3A%2F%2Fbusiness.example.com%2Fcallback&state=abc&request_id=' + secrets.token_urlsafe(32)
    from urllib.parse import quote
    return_to = '/auth?next=' + quote(next_path, safe='')
    started = client.post(f'/api/auth/external/{source}/start', json={'return_to':return_to})
    state = parse_qs(urlsplit(started.json()['authorization_url']).query)['state'][0]
    result = client.get(f'/api/auth/external/{source}/callback', params={'state':state,'code':'valid-code'}, follow_redirects=False)
    assert result.headers['location'] == '/auth/pending?next=' + quote(next_path, safe='')
    assert 'set-cookie' not in result.headers


def test_exchange_write_lock_does_not_block_health(actor, tmp_path):
    app, client, headers = actor
    configure(client, headers)
    code, request_id = issue(client, headers)
    reached = threading.Event()
    engine = app.state.database.engine.sync_engine
    def before_execute(_conn, _cursor, statement, *_args):
        if statement.startswith('UPDATE third_party_auth_codes'):
            reached.set()
    event.listen(engine, 'before_cursor_execute', before_execute)
    async def scenario():
        async with AsyncClient(transport=ASGITransport(app), base_url='https://gateway.test') as remote:
            pending = asyncio.create_task(remote.post('/api/auth/exchange', json={'code':code,'request_id':request_id}))
            try:
                assert await asyncio.to_thread(reached.wait, 2)
                assert (await asyncio.wait_for(remote.get('/api/health'), .5)).status_code == 200
                assert not pending.done()
            finally:
                await asyncio.to_thread(lock.rollback)
                await pending
    try:
        with sqlite3.connect(tmp_path/'workstep_platform.db', check_same_thread=False) as lock:
            lock.execute('BEGIN IMMEDIATE')
            client.portal.call(scenario)
    finally:
        event.remove(engine, 'before_cursor_execute', before_execute)
