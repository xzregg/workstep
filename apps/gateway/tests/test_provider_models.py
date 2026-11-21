import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, UserDevice
from gateway.services import provider_models_api as models_api
from gateway.services.providers_api import compile_provider_bundle
from test_platform_providers import _bundle_data


def test_models_are_previewed_then_selected_and_distributed(tmp_path, monkeypatch):
    requests = []
    entered, release = threading.Event(), threading.Event()

    async def upstream(request):
        requests.append(request)
        entered.set()
        while not release.is_set():
            await asyncio.sleep(.01)
        return httpx.Response(200, json={"data": [{"id": "model-a"}, {"id": "model-b"}]})

    monkeypatch.setattr(models_api, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post('/api/platform/setup', json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        }).json()
        headers = {"X-CSRF-Token": setup['csrf_token']}
        client.post('/api/auth/step-up', json={"password": "OwnerPassphrase-2026!"}, headers=headers)
        body = {"name": "Company", "type": "custom", "protocols": ["openai_responses", "openai_chat_completions"],
                "protocol_base_urls": {p: "https://api.example.test/v1" for p in ["openai_responses", "openai_chat_completions"]},
                "api_key": "private-api-key", "models": ["model-a"], "prices": {"model-a": {"input_per_million": "1"}}}
        created = client.post('/api/admin/providers', json=body, headers=headers).json()
        provider_id = created['id']
        url = f'/api/admin/providers/{provider_id}/models'
        assert client.post(url + '/preview').status_code == 403
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(client.post, url + '/preview', headers=headers)
            try:
                assert entered.wait(1)
                assert not pending.done()
                assert client.get('/api/health').status_code == 200
                assert not pending.done(), 'health responds while model discovery is waiting'
            finally:
                release.set()
            preview = pending.result(timeout=2)
        assert preview.status_code == 200, preview.text
        assert [m['id'] for m in preview.json()['models']] == ['model-a', 'model-b']
        assert 'private-api-key' not in preview.text
        assert len(requests) == 1, 'same endpoint and auth share discovery across OpenAI protocols'
        assert requests[0].headers['authorization'] == 'Bearer private-api-key'
        assert str(requests[0].url) == 'https://api.example.test/v1/models'
        assert client.get('/api/admin/providers').json()['providers'][0]['models'] == ['model-a']
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='pc', name='PC', public_key='test', status='active', app_instance_id='app', version='1'))
                    session.add(UserDevice(id='link', user_id=setup['user']['id'], device_id='pc', access_level='edit'))
        client.portal.call(seed)
        selected = {'revision': created['revision'], 'models': ['model-b']}
        assert client.put(url, json=selected).status_code == 403
        saved = client.put(url, json=selected, headers=headers)
        assert saved.status_code == 200, saved.text
        assert saved.json()['models'] == ['model-b']
        assert saved.json()['prices']['models'] == {}
        assert client.put(url, json=selected, headers=headers).status_code == 409
        assert client.put(url, json={'revision': saved.json()['revision'], 'models': ['bad', 'bad']}, headers=headers).status_code == 422
        key = X25519PrivateKey.generate()
        pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        token = client.portal.call(compile_provider_bundle, app.state.database, app.state.gateway_signer,
                                  'gateway-test', 'pc', setup['user']['id'], pem)
        payload = _bundle_data(token, key)
        assert payload['providers'][0]['models'] == ['model-b']
        assert payload['providers'][0]['api_key'] == 'private-api-key'
        async def revision():
            async with app.state.database.session() as session:
                return (await session.get(Device, 'pc')).provider_revision
        assert client.portal.call(revision) > 0
        client.post('/api/admin/providers/' + provider_id + '/disable', headers=headers)
        assert client.post(url + '/preview', headers=headers).status_code == 404


@pytest.mark.asyncio
async def test_discovery_is_async_bounded_and_sanitizes_failures(monkeypatch):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def upstream(request):
        entered.set()
        await release.wait()
        if request.headers.get('x-api-key'):
            return httpx.Response(200, json={'data': [{'id': 'claude-a'}], 'has_more': False})
        return httpx.Response(401, text='private-api-key')

    monkeypatch.setattr(models_api, '_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
    pending = asyncio.create_task(models_api.discover_models({
        'protocols': ['anthropic_messages', 'openai_responses'],
        'protocol_base_urls': {'anthropic_messages': 'https://api.example.test', 'openai_responses': 'https://api.example.test/v1'},
    }, 'private-api-key'))
    await asyncio.wait_for(entered.wait(), .2)
    await asyncio.wait_for(asyncio.sleep(.01), .1)
    release.set()
    result = await pending
    assert result['models'] == [{'id': 'claude-a'}]
    assert result['errors'] == [{'protocol': 'openai_responses', 'error': '读取模型列表失败，请检查供应商地址与凭据。'}]
    assert 'private-api-key' not in json.dumps(result)


@pytest.mark.asyncio
async def test_anthropic_discovery_follows_pages_and_preserves_base_path(monkeypatch):
    requests = []

    async def upstream(request):
        requests.append(request)
        assert request.headers['x-api-key'] == 'test-key'
        assert request.headers['anthropic-version'] == '2023-06-01'
        assert request.url.path == '/proxy/v1/models'
        if request.url.params.get('after_id') is None:
            return httpx.Response(200, json={'data': [{'id': 'claude-a'}], 'has_more': True, 'last_id': 'claude-a'})
        assert request.url.params['after_id'] == 'claude-a'
        return httpx.Response(200, json={'data': [{'id': 'claude-b'}], 'has_more': False})

    monkeypatch.setattr(models_api, '_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
    result = await models_api.discover_models({
        'protocols': ['anthropic_messages'],
        'protocol_base_urls': {'anthropic_messages': 'https://api.example.test/proxy/v1/'},
    }, 'test-key')
    assert result == {'models': [{'id': 'claude-a'}, {'id': 'claude-b'}], 'errors': []}
    assert len(requests) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize('payload', [[], {'data': [{'id': 'bad '}]}, {'data': [{'id': 'x' * 129}]}])
async def test_discovery_rejects_invalid_catalog_without_exposing_response(monkeypatch, payload):
    monkeypatch.setattr(models_api, '_client', lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload))))
    result = await models_api.discover_models({
        'protocols': ['openai_responses'],
        'protocol_base_urls': {'openai_responses': 'https://api.example.test/v1'},
    }, 'test-key')
    assert result == {'models': [], 'errors': [{'protocol': 'openai_responses', 'error': models_api.DISCOVERY_ERROR}]}
