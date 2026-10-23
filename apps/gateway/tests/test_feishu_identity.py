"""Feishu/Lark contracts use synthetic credentials and offline HTTP transports."""
import asyncio
import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import IdentitySource
from gateway.services.feishu_identity import FeishuConnector
from test_external_identity import _setup


@pytest.mark.parametrize('provider,host', [('feishu', 'open.feishu.cn'), ('lark', 'open.larksuite.com')])
async def test_login_uses_region_pkce_and_verified_tenant(monkeypatch, provider, host):
    monkeypatch.setenv('FEISHU_TEST_SECRET', 'private-secret')
    source = IdentitySource(id='source', provider=provider, tenant_id='tenant', client_id='cli_app', secret_env='FEISHU_TEST_SECRET')
    def handle(request):
        assert request.url.host == host
        if request.url.path.endswith('/oauth/token'):
            body = json.loads(request.content)
            assert body['code_verifier'] == 'nonce'
            assert body['redirect_uri'] == 'https://gateway.test/callback'
            return httpx.Response(200, json={'code': 0, 'access_token': 'user-token'})
        assert request.headers['Authorization'] == 'Bearer user-token'
        return httpx.Response(200, json={'code': 0, 'data': {'tenant_key': 'tenant', 'open_id': 'ou_user', 'name': '成员'}})
    connector = FeishuConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    url = connector.authorization_url(source, 'state', 'nonce', 'https://gateway.test/callback')
    query = parse_qs(urlsplit(url).query)
    assert query['state'] == ['state'] and query['code_challenge_method'] == ['S256']
    assert urlsplit(url).hostname == ('accounts.feishu.cn' if provider == 'feishu' else 'accounts.larksuite.com')
    profile = await connector.exchange_code(source, 'code', 'nonce', redirect_uri='https://gateway.test/callback')
    assert (profile.tenant_id, profile.subject, profile.display_name) == ('tenant', 'ou_user', '成员')


@pytest.mark.parametrize('payload', [
    {'tenant_key': 'outsider', 'open_id': 'ou_user'}, {'tenant_key': 'tenant'},
])
async def test_login_rejects_wrong_tenant_or_missing_identity(monkeypatch, payload):
    monkeypatch.setenv('FEISHU_TEST_SECRET', 'secret')
    source = IdentitySource(id='source', provider='feishu', tenant_id='tenant', client_id='app', secret_env='FEISHU_TEST_SECRET')
    def handle(request):
        return httpx.Response(200, json={'code': 0, 'access_token': 'token'} if request.url.path.endswith('/oauth/token') else {'code': 0, 'data': payload})
    connector = FeishuConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    with pytest.raises(ValueError):
        await connector.exchange_code(source, 'code', 'nonce', redirect_uri='https://gateway.test/callback')


@pytest.mark.parametrize('provider', ['feishu', 'lark'])
async def test_directory_preview_selected_pagination_scope_and_stable_subject(monkeypatch, provider):
    monkeypatch.setenv('FEISHU_TEST_SECRET', 'secret')
    source = IdentitySource(id='source', provider=provider, tenant_id='tenant', client_id='app', secret_env='FEISHU_TEST_SECRET')
    calls = []
    def handle(request):
        calls.append(request)
        path = request.url.path
        if path.endswith('/tenant_access_token/internal'):
            return httpx.Response(200, json={'code': 0, 'tenant_access_token': 'token', 'expire': 7200})
        assert request.headers['Authorization'] == 'Bearer token'
        if path.endswith('/scopes'):
            return httpx.Response(200, json={'code': 0, 'data': {'department_ids': ['od_team'], 'has_more': False}})
        if path.endswith('/children'):
            return httpx.Response(200, json={'code': 0, 'data': {'items': [
                {'open_department_id': 'od_team', 'name': '研发', 'parent_department_id': '0'},
                {'open_department_id': 'od_child', 'name': '后端', 'parent_department_id': 'od_team'},
                {'open_department_id': 'od_other', 'name': '销售', 'parent_department_id': '0'},
            ], 'has_more': False}})
        assert request.url.params['user_id_type'] == 'open_id'
        department = request.url.params['department_id']
        assert department in {'od_team', 'od_child'}
        more = department == 'od_team' and not request.url.params.get('page_token')
        return httpx.Response(200, json={'code': 0, 'data': {'items': [{
            'open_id': 'ou_user', 'name': '成员', 'department_ids': ['od_team', 'od_child'], 'status': {'is_activated': True},
        }], 'has_more': more, 'page_token': 'next' if more else ''}})
    connector = FeishuConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    preview = await connector.fetch_directory(source, departments_only=True)
    assert not any(request.url.path.endswith('/find_by_department') for request in calls)
    result = await connector.fetch_directory(source, selected_department_ids=['od_team'], preloaded_departments=preview['departments'])
    assert {row['external_id'] for row in result['departments']} == {'od_team', 'od_child'}
    assert result['people'][0]['subject'] == 'ou_user' and len(result['people']) == 1
    assert result['complete'] is True and result['whole_company'] is False
    assert len([r for r in calls if r.url.path.endswith('/children')]) == 1


async def test_slow_directory_network_keeps_health_responsive(tmp_path, monkeypatch):
    monkeypatch.setenv('FEISHU_TEST_SECRET', 'secret')
    entered, release = asyncio.Event(), asyncio.Event()
    async def handle(request):
        entered.set()
        await release.wait()
        return httpx.Response(200, json={'code': 0, 'tenant_access_token': 'token'})
    connector = FeishuConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    source = IdentitySource(id='source', provider='feishu', tenant_id='tenant', client_id='app', secret_env='FEISHU_TEST_SECRET')
    pending = asyncio.create_task(connector.fetch_directory(source))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        app = create_app(GatewaySettings(data_dir=tmp_path))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.parametrize('provider', ['feishu', 'lark'])
def test_source_api_registration_login_policy_and_secret_redaction(tmp_path, provider):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client)}
        response = client.post('/api/admin/identity-sources', headers=headers, json={
            'provider': provider, 'tenant_id': 'tenant', 'client_id': 'cli_app', 'client_secret': 'private-secret',
        })
        assert response.status_code == 201, response.text
        source_id = response.json()['id']
        assert client.get('/api/auth/identity-sources').json()['sources'] == [{'id': source_id, 'provider': provider}]
        listing = client.get('/api/admin/identity-sources', params={'provider': provider})
        assert listing.status_code == 200 and listing.json()['total'] == 1
        assert 'private-secret' not in listing.text
        start = client.post(f'/api/auth/external/{source_id}/start')
        assert start.status_code == 200 and 'cli_app' in start.json()['authorization_url']
        changed = client.put(f'/api/admin/identity-sources/{source_id}', headers=headers, json={
            'provider': provider, 'tenant_id': 'tenant', 'client_id': 'another-app',
        })
        assert changed.status_code == 409


@pytest.mark.parametrize('provider', ['feishu', 'lark'])
def test_real_connector_callback_reuses_synced_member_and_rejects_replay(tmp_path, monkeypatch, provider):
    monkeypatch.setenv('FEISHU_TEST_SECRET', 'secret')
    callback = None
    def handle(request):
        if request.url.path.endswith('/oauth/token'):
            body = json.loads(request.content)
            assert body['redirect_uri'] == callback
            assert len(body['code_verifier']) >= 43
            return httpx.Response(200, json={'code': 0, 'access_token': 'token'})
        return httpx.Response(200, json={'code': 0, 'data': {'tenant_key': 'tenant', 'open_id': 'ou_member', 'name': '成员'}})
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors[provider] = FeishuConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    with TestClient(app, base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client)}
        source = client.post('/api/admin/identity-sources', headers=headers, json={
            'provider': provider, 'tenant_id': 'tenant', 'client_id': 'cli_app', 'secret_env': 'FEISHU_TEST_SECRET',
        }).json()['id']
        snapshot = {'departments': [{'external_id': 'od_team', 'display_name': '研发'}],
                    'people': [{'subject': 'ou_member', 'display_name': '成员', 'department_ids': ['od_team']}]}
        assert client.post(f'/api/admin/identity-sources/{source}/sync', headers=headers, json=snapshot).status_code == 200
        member = next(user for user in client.get('/api/admin/users').json()['users'] if user['display_name'] == '成员')
        client.cookies.clear()
        start = client.post(f'/api/auth/external/{source}/start').json()['authorization_url']
        state = parse_qs(urlsplit(start).query)['state'][0]
        callback = 'https://gateway.test/api/auth/external/' + source + '/callback'
        url = callback + '?state=' + state + '&code=code'
        response = client.get(url)
        assert response.status_code == 200, response.text
        assert response.json()['user']['id'] == member['id']
        assert client.get(url).status_code == 409


@pytest.mark.parametrize('failure', ['scope_denied', 'repeated_cursor', 'missing_items', 'resigned'])
async def test_directory_handles_restricted_scope_bad_pages_and_departed_members(monkeypatch, failure):
    monkeypatch.setenv('FEISHU_TEST_SECRET', 'secret')
    source = IdentitySource(id='source', provider='feishu', tenant_id='tenant', client_id='app', secret_env='FEISHU_TEST_SECRET')
    def handle(request):
        path = request.url.path
        if path.endswith('/internal'):
            return httpx.Response(200, json={'code': 0, 'tenant_access_token': 'token'})
        if path.endswith('/scopes'):
            return httpx.Response(200, json={'code': 99991672} if failure == 'scope_denied' else {'code': 0, 'data': {'department_ids': ['0'], 'has_more': False}})
        if path.endswith('/children'):
            return httpx.Response(200, json={'code': 0, 'data': {'items': [{'open_department_id': 'od_team', 'name': '研发', 'parent_department_id': '0'}], 'has_more': False}})
        data = {'has_more': failure == 'repeated_cursor', 'page_token': 'same'}
        if failure != 'missing_items':
            data['items'] = [{'open_id': 'ou_user', 'department_ids': ['od_team'], 'status': {'is_resigned': failure == 'resigned'}}]
        return httpx.Response(200, json={'code': 0, 'data': data})
    connector = FeishuConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    if failure in {'repeated_cursor', 'missing_items'}:
        with pytest.raises(ValueError):
            await connector.fetch_directory(source, selected_department_ids=['od_team'])
    else:
        result = await connector.fetch_directory(source, selected_department_ids=['od_team'])
        assert result['complete'] is (failure != 'scope_denied')
        assert result['people'][0]['active'] is (failure != 'resigned')
