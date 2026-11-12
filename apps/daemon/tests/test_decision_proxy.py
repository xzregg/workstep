import asyncio
import time

import httpx
import pytest
from fastapi import FastAPI

from api import decision_models
from services.decision_models import DecisionModelService, TEST_PAYLOAD
from services.remote_access import RemoteAccessService


class MemoryConfig:
    def __init__(self): self.data = {}
    def get(self, key, default=None): return self.data.get(key, default)
    def set(self, key, value): self.data[key] = value


@pytest.fixture
def setup(tmp_path, monkeypatch):
    from api.decision_proxy import DecisionProxyMiddleware
    from api.desktop_security import DesktopSecurityMiddleware
    remote = RemoteAccessService(MemoryConfig(), daemon_host='0.0.0.0', daemon_port=9876,
                                 network_address_resolver=lambda: '192.168.1.10')
    remote.update_settings(enabled=True, internal_base_url='', external_base_url='https://example.com/workstep')
    value = DecisionModelService(tmp_path)
    value.remote_access = remote
    monkeypatch.setattr(decision_models, 'service', value)
    a = FastAPI()
    a.include_router(decision_models.router)
    @a.get('/health')
    async def health(): return {'ok': True}
    a.add_middleware(DesktopSecurityMiddleware)
    a.add_middleware(DecisionProxyMiddleware, service=value)
    return value, remote, a


@pytest.mark.asyncio
async def test_proxy_reuses_remote_key_and_does_not_grant_management(setup, monkeypatch):
    value, remote, a = setup
    remote.set_access_password('existing-key')
    await value.configure({'mode': 'managed', 'proxy_enabled': True})
    snapshot = await value.snapshot()
    assert snapshot['proxy']['lan_url'] == 'http://192.168.1.10:9876/api/decision-models/v1'
    assert snapshot['proxy']['remote_url'] == 'https://example.com/workstep/api/decision-models/v1'
    assert 'existing-key' not in str(snapshot)
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'native-key')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url='http://host') as c:
        path = '/api/decision-models/v1/models'
        assert (await c.get(path)).status_code == 401
        headers = {'Authorization': 'Bearer existing-key'}
        assert (await c.get(path, headers=headers)).status_code == 200
        assert (await c.get('/api/decision-models', headers=headers)).status_code == 401
        assert (await c.get(path, headers={'X-WorkStep-Access': bytes([57] * 11 + [46, 255])})).status_code == 401
        remote.set_access_password('new-key')
        assert (await c.get(path, headers=headers)).status_code == 401
        token = remote.issue_access_token()
        assert (await c.get(path, headers={'X-WorkStep-Access': token})).status_code == 200
        remote.set_access_password('')
        assert (await c.get(path, headers={'X-WorkStep-Access': token})).status_code == 503
    await value.close()


@pytest.mark.asyncio
async def test_enable_requires_key_and_external_modes_never_proxy(setup):
    value, remote, a = setup
    with pytest.raises(ValueError):
        await value.configure({'mode': 'managed', 'proxy_enabled': True})
    await value.configure({'mode': 'managed', 'proxy_enabled': True, 'access_key': 'new-key'})
    assert remote.verify_access_password('new-key')
    await value.configure({'mode': 'remote', 'base_url': 'https://example.com', 'model': 'jev', 'proxy_enabled': True})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url='http://host') as c:
        assert (await c.get('/api/decision-models/v1/models', headers={'Authorization': 'Bearer new-key'})).status_code == 503
    await value.close()


@pytest.mark.asyncio
async def test_bounded_inference_and_slow_disk_leave_health_responsive(setup, monkeypatch):
    value, remote, a = setup
    await value.configure({'mode': 'managed', 'proxy_enabled': True, 'access_key': 'new-key'})
    entered = asyncio.Event(); release = asyncio.Event()
    monkeypatch.setattr(value.resources, 'installed', lambda kind: True)
    def verify(kind='model'): time.sleep(.15)
    monkeypatch.setattr(value.resources, 'verify_model', verify)
    async def infer(*args):
        entered.set(); await release.wait()
        return {'answers': {'ready': {'noul': .9}}}
    monkeypatch.setattr(value.runtime, 'test', infer)
    headers = {'Authorization': 'Bearer new-key'}
    path = '/api/decision-models/v1/systemone'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url='http://host') as c:
        assert (await c.post(path, headers=headers, content=b'x' * 65537)).status_code == 413
        assert (await c.post(path, headers=headers, json={'state': 'x', 'questions': {}})).status_code == 422
        assert (await c.post(path, headers=headers, json={**TEST_PAYLOAD, 'model': 'unknown'})).status_code == 422
        job = asyncio.create_task(c.post(path, headers=headers, json=TEST_PAYLOAD))
        await asyncio.sleep(.03)
        assert (await asyncio.wait_for(c.get('/health'), .08)).status_code == 200
        await asyncio.wait_for(entered.wait(), 2)
        responses = await asyncio.gather(*(c.post(path, headers=headers, json=TEST_PAYLOAD) for _ in range(30)))
        assert all(response.status_code == 429 for response in responses)
        assert (await asyncio.wait_for(c.get('/health'), .08)).status_code == 200
        release.set()
        assert (await job).json()['answers']['ready']['noul'] == .9
        async def chunks():
            yield b'x' * 40000
            yield b'x' * 40000
        assert (await c.post(path, headers=headers, content=chunks())).status_code == 413
    await value.close()


@pytest.mark.asyncio
async def test_real_worker_bounds_native_threads_and_reuses_loaded_model(tmp_path):
    from services.decision_runtime import DecisionRuntime
    lib = tmp_path / 'lib'; lib.mkdir()
    (lib / 'torch.py').write_text('threads = interop = 0\ndef set_num_threads(n):\n global threads; threads=n\ndef set_num_interop_threads(n):\n global interop; interop=n\n')
    (lib / 'transformers.py').write_text('')
    (lib / 'laya.py').write_text('import os,torch\nclass Model:\n def system_one(self, state, questions):\n  return {"pid":os.getpid(), "threads":torch.threads,"interop":torch.interop,"env":os.environ["OMP_NUM_THREADS"]}\ndef load(*args,**kwargs): return Model()\n')
    runtime = DecisionRuntime()
    try:
        first = await runtime.test(tmp_path, tmp_path, TEST_PAYLOAD)
        second = await runtime.test(tmp_path, tmp_path, TEST_PAYLOAD)
        assert first == second
        assert first['threads'] == first['interop'] == 1
        assert first['env'] == '1'
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_warm_inference_does_not_read_resource_or_settings_files(setup, monkeypatch):
    from types import SimpleNamespace
    value, remote, _ = setup
    await value.configure({'mode': 'managed', 'proxy_enabled': True, 'access_key': 'new-key'})
    def forbidden(*args): pytest.fail('warm path performed filesystem lookup')
    monkeypatch.setattr(value, '_read_settings', forbidden)
    monkeypatch.setattr(value.resources, 'installed', forbidden)
    monkeypatch.setattr(value.resources, 'verify_model', forbidden)
    async def infer(*args): return {'answers': {'ready': {'noul': .9}}}
    monkeypatch.setattr(value.runtime, 'test', infer)
    value.runtime.process = SimpleNamespace(returncode=None)
    value.runtime.model_path = value.resources.path('model')
    try:
        assert (await value.infer(TEST_PAYLOAD))['answers']['ready']['noul'] == .9
    finally:
        value.runtime.process = None
        await value.close()


@pytest.mark.asyncio
async def test_proxy_advertises_and_runs_saved_selection_after_draft_test(setup, monkeypatch):
    value, remote, a = setup
    await value.configure({'mode':'managed','proxy_enabled':True,'access_key':'new-key','managed_model':'laya'})
    monkeypatch.setattr(value.resources, 'installed', lambda kind: True)
    monkeypatch.setattr(value.resources, 'verify_model', lambda kind='model': None)
    seen = []
    async def infer(runtime, model, payload):
        seen.append(model.name)
        return {'answers': {'ready': {'noul': .9}}}
    monkeypatch.setattr(value.runtime, 'test', infer)
    await value.test({'mode':'managed','managed_model':'laya-typed-decisions'})
    headers = {'Authorization':'Bearer new-key'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url='http://host') as c:
        data = (await c.get('/api/decision-models/v1/models', headers=headers)).json()
        assert data['data'][0]['id'] == 'laya'
        path = '/api/decision-models/v1/systemone'
        assert (await c.post(path, headers=headers, json={**TEST_PAYLOAD,'model':'laya-multilingual'})).status_code == 422
        assert (await c.post(path, headers=headers, json=TEST_PAYLOAD)).status_code == 200
    assert seen == ['laya-typed-decisions', 'laya']
    await value.close()
