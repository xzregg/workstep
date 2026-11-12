import asyncio
import time
import httpx
import pytest
from fastapi import FastAPI
from api import decision_models
from services.decision_models import DecisionModelService

@pytest.fixture
def service(tmp_path, monkeypatch):
    value = DecisionModelService(tmp_path / 'decision-models')
    monkeypatch.setattr(decision_models, 'service', value)
    return value

def app():
    a = FastAPI()
    a.include_router(decision_models.router)
    @a.get('/health')
    async def health():
        return {'ok': True}
    return a

@pytest.mark.asyncio
async def test_default_status_save_and_test_never_implicitly_download(service, monkeypatch):
    async def forbidden(*args):
        pytest.fail('implicit download')
    monkeypatch.setattr(service.resources, 'download', forbidden)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as c:
        data = (await c.get('/api/decision-models')).json()
        assert data['settings']['mode'] == 'managed'
        assert data['resources']['model']['path'].endswith('models/laya-multilingual')
        assert not service.root.exists()
        assert (await c.put('/api/decision-models/settings', json={'mode': 'managed'})).status_code == 200
        assert (await c.post('/api/decision-models/test', json={'mode': 'managed'})).status_code == 409
    await service.close()

@pytest.mark.asyncio
async def test_external_draft_canary_no_save_and_credential_redaction(service):
    seen = []
    async def reply(request):
        seen.append(request)
        await asyncio.sleep(.12)
        return httpx.Response(200, json={'answers': {'ready': {'noul': .9}}})
    service.transport = httpx.MockTransport(reply)
    body = {'mode': 'remote', 'base_url': 'https://example.com', 'model': 'jev', 'api_key': 'private-value'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as c:
        job = asyncio.create_task(c.post('/api/decision-models/test', json=body))
        await asyncio.sleep(.02)
        assert not job.done()
        assert (await asyncio.wait_for(c.get('/health'), .08)).status_code == 200
        result = await job
        assert result.status_code == 200
        assert seen[0].url.path == '/v1/systemone'
        assert seen[0].headers['authorization'] == 'Bearer private-value'
        assert (await service.snapshot())['settings']['mode'] == 'managed'
        saved = await c.put('/api/decision-models/settings', json=body)
        assert 'private-value' not in saved.text
        assert saved.json()['settings']['has_api_key']
        kept = await c.put('/api/decision-models/settings', json={**body, 'api_key': None})
        assert kept.json()['settings']['has_api_key']
        changed = await c.put('/api/decision-models/settings', json={**body, 'base_url': 'https://other.example', 'api_key': None})
        assert not changed.json()['settings']['has_api_key']
    assert 'private-value' not in (service.root / 'settings.json').read_text()
    await service.close()

@pytest.mark.asyncio
async def test_external_validation_and_errors_do_not_leak(service):
    service.transport = httpx.MockTransport(lambda r: httpx.Response(401, text='private-response'))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as c:
        for url in ['file:///tmp/model', 'https://key@example.com', 'https://example.com/?key=x']:
            r = await c.put('/api/decision-models/settings', json={'mode': 'remote', 'base_url': url, 'model': 'jev'})
            assert r.status_code == 422
        r = await c.post('/api/decision-models/test', json={'mode': 'local', 'base_url': 'http://127.0.0.1:6000', 'model': 'multilingual'})
        assert r.status_code == 409
        assert 'private-response' not in r.text
        service.transport = httpx.MockTransport(lambda r: httpx.Response(200, json={'answers': {'ready': {'noul': 4}}}))
        assert (await c.post('/api/decision-models/test', json={'mode': 'remote', 'base_url': 'https://example.com', 'model': 'jev'})).status_code == 409
    await service.close()

@pytest.mark.asyncio
async def test_download_failure_cancel_cleanup(service, monkeypatch):
    async def fail(kind, stage):
        raise ValueError('private-url')
    monkeypatch.setattr(service.resources, '_install', fail)
    await service.resources.download('model')
    await service.resources.task
    data = await service.snapshot()
    assert data['resources']['model']['stage'] == 'error'
    assert 'private-url' not in str(data)
    assert not data['resources']['model']['installed']
    async def wait(kind, stage):
        await asyncio.Event().wait()
    monkeypatch.setattr(service.resources, '_install', wait)
    await service.resources.download('runtime')
    await asyncio.sleep(.01)
    await service.resources.cancel('runtime')
    assert service.resources.states['runtime']['stage'] == 'cancelled'
    assert not list(service.root.glob('.install-*'))
    await service.close()

@pytest.mark.asyncio
async def test_slow_disk_canary(service, monkeypatch):
    original = service.resources.snapshot
    def slow():
        time.sleep(.15)
        return original()
    monkeypatch.setattr(service.resources, 'snapshot', slow)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as c:
        job = asyncio.create_task(c.get('/api/decision-models'))
        await asyncio.sleep(.02)
        assert not job.done()
        assert (await asyncio.wait_for(c.get('/health'), .08)).status_code == 200
        assert (await job).status_code == 200
    await service.close()

def test_host_scope_and_retired_capability(service):
    from services.remote_access import ActorSnapshot, _current_actor
    decision_models.authorize()
    token = _current_actor.set(ActorSnapshot(actor_id='u', user_name='u', device_id='d', device_name='d', source='managed', project_id='p', access_level='edit'))
    try:
        with pytest.raises(decision_models.HTTPException) as e:
            decision_models.authorize()
        assert e.value.status_code == 403
    finally:
        _current_actor.reset(token)

@pytest.mark.asyncio
async def test_stream_download_verifies_hash_and_size(tmp_path):
    import hashlib
    from services.decision_resources import DecisionResources
    data = b'verified local model'
    state = {'downloaded_bytes': 0}
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=data))) as client:
        await DecisionResources.fetch(client, 'https://example.com/model', tmp_path / 'model', len(data), hashlib.sha256(data).hexdigest(), state)
        assert state['downloaded_bytes'] == len(data)
        with pytest.raises(ValueError):
            await DecisionResources.fetch(client, 'https://example.com/model', tmp_path / 'bad', len(data), '0' * 64, state)

@pytest.mark.asyncio
async def test_real_worker_protocol_reuses_process_and_can_be_released(tmp_path, monkeypatch):
    import sys
    from services.decision_runtime import DecisionRuntime
    script = tmp_path / 'fake_worker.py'
    script.write_text('import sys,json\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({"id":r["id"],"result":{"answers":{"ready":{"noul":0.9}}}}),flush=True)\n')
    original = asyncio.create_subprocess_exec
    async def spawn(*args, **kwargs):
        return await original(sys.executable, '-I', str(script), **kwargs)
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    runtime = DecisionRuntime()
    try:
        payload = {'state': 'ready', 'questions': {}}
        assert (await runtime.test(tmp_path, tmp_path, payload))['answers']['ready']['noul'] == .9
        pid = runtime.process.pid
        await runtime.test(tmp_path, tmp_path, payload)
        assert runtime.process.pid == pid
        assert runtime.state == 'ready'
    finally:
        await runtime.close()
    assert runtime.process is None

@pytest.mark.asyncio
async def test_model_deletion_preserves_settings_and_other_resource(service):
    root = service.root
    await service.configure({'mode': 'local', 'base_url': 'http://127.0.0.1:6000', 'model': 'multilingual'})
    runtime = service.resources.path('runtime'); runtime.mkdir(parents=True)
    (runtime / 'keep').write_text('runtime')
    model = service.resources.path('model'); model.mkdir(parents=True)
    (model / 'model').write_text('model')
    await service.delete('model')
    assert not model.exists()
    assert (runtime / 'keep').exists()
    assert (await service.snapshot())['settings']['mode'] == 'local'
    await service.close()

@pytest.mark.asyncio
async def test_release_interrupts_real_loading_process_without_waiting_for_timeout(tmp_path, monkeypatch):
    import sys
    from services.decision_runtime import DecisionRuntime
    script = tmp_path / 'slow_worker.py'
    script.write_text('import time\ntime.sleep(60)\n')
    original = asyncio.create_subprocess_exec
    async def spawn(*args, **kwargs):
        return await original(sys.executable, '-I', str(script), **kwargs)
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    runtime = DecisionRuntime()
    task = asyncio.create_task(runtime.test(tmp_path, tmp_path, {'state': '', 'questions': {}}))
    try:
        for _ in range(50):
            if runtime.process: break
            await asyncio.sleep(.01)
        assert runtime.process
        await asyncio.wait_for(runtime.close(), 1)
        result = await asyncio.gather(task, return_exceptions=True)
        assert isinstance(result[0], Exception)
        assert runtime.process is None
        assert runtime.state == 'stopped'
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await runtime.close()

@pytest.mark.asyncio
async def test_explicit_model_download_publishes_verified_resource_only(service, monkeypatch):
    import hashlib
    import services.decision_resources as resources_module
    data = b'small fixture model'
    monkeypatch.setattr(resources_module, 'MODEL_FILES', [('model.safetensors', len(data), hashlib.sha256(data).hexdigest())])
    original = httpx.AsyncClient
    def client(**kwargs):
        return original(**kwargs, transport=httpx.MockTransport(lambda r: httpx.Response(200, content=data)))
    monkeypatch.setattr(resources_module.httpx, 'AsyncClient', client)
    assert not service.resources.installed('model')
    await service.resources.download('model')
    await service.resources.task
    assert service.resources.installed('model')
    service.resources.verify_model()
    assert not service.resources.installed('runtime')
    assert not list(service.root.glob('.install-*'))
    await service.close()


def test_host_actor_is_allowed_even_when_retired_capability_rejects(service, monkeypatch):
    from services.remote_access import ActorSnapshot, _current_actor
    import services.gateway_client.policy as policy
    def reject(*args):
        raise AssertionError('retired capability must not be consulted')
    monkeypatch.setattr(policy, 'require_managed_capability', reject)
    token = _current_actor.set(ActorSnapshot(actor_id='u', user_name='u', device_id='d', device_name='d', source='managed', project_id=None, access_level='edit'))
    try:
        decision_models.authorize()
    finally:
        _current_actor.reset(token)

@pytest.mark.asyncio
async def test_cancel_before_download_task_starts_reports_cancelled(service):
    await service.resources.download('model')
    await service.resources.cancel('model')
    assert service.resources.states['model']['stage'] == 'cancelled'
    assert not service.resources.installed('model')
    await service.close()


@pytest.mark.asyncio
async def test_external_models_reuses_key_without_model_or_save_and_keeps_loop_responsive(service):
    seen=[]
    async def reply(request):
        seen.append(request);await asyncio.sleep(.12)
        return httpx.Response(200,json={'data':[{'id':'z-model'},{'id':'a-model'},{'id':'z-model'}]})
    service.transport=httpx.MockTransport(reply)
    await service.configure({'mode':'remote','base_url':'https://example.com/v1','model':'old','api_key':'secret-value'})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()),base_url='http://host') as c:
        job=asyncio.create_task(c.post('/api/decision-models/models',json={'mode':'remote','base_url':'https://example.com/v1'}))
        await asyncio.sleep(.02)
        assert (await asyncio.wait_for(c.get('/health'),.08)).status_code==200
        response=await job
        assert response.status_code==200
        assert response.json()=={'models':['a-model','z-model']}
        assert seen[0].url.path=='/v1/models'
        assert seen[0].headers['authorization']=='Bearer secret-value'
        assert (await service.snapshot())['settings']['model']=='old'
        assert 'secret-value' not in response.text
    await service.close()


@pytest.mark.asyncio
async def test_models_no_key_leak_to_changed_endpoint_no_redirect_and_manual_fallback(service):
    await service.configure({'mode':'local','base_url':'http://127.0.0.1:6000','model':'old','api_key':'secret-value'})
    seen=[]
    def reply(request):
        seen.append(request)
        return httpx.Response(302,headers={'Location':'https://other.example'},text='secret-response')
    service.transport=httpx.MockTransport(reply)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()),base_url='http://host') as c:
        body={'mode':'local','base_url':'http://127.0.0.1:6001'}
        response=await c.post('/api/decision-models/models',json=body)
        assert response.status_code==409 and len(seen)==1
        assert 'authorization' not in seen[0].headers
        assert 'secret-response' not in response.text
        for code in [401,404,500]:
            service.transport=httpx.MockTransport(lambda request:httpx.Response(code,text='secret-response'))
            response=await c.post('/api/decision-models/models',json=body)
            assert response.status_code==409 and 'secret-response' not in response.text
        service.transport=httpx.MockTransport(lambda request:httpx.Response(200,content=b'x'*(1024*1024+1)))
        assert (await c.post('/api/decision-models/models',json=body)).status_code==409
        assert (await service.snapshot())['settings']['model']=='old'
    await service.close()


@pytest.mark.asyncio
async def test_models_api_denies_project_identity_before_network(service):
    from services.remote_access import ActorSnapshot, _current_actor
    def forbidden(request): pytest.fail('unauthorized network access')
    service.transport=httpx.MockTransport(forbidden)
    token=_current_actor.set(ActorSnapshot(actor_id='u',user_name='u',device_id='d',device_name='d',source='managed',project_id='p',access_level='edit'))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()),base_url='http://host') as c:
            response=await c.post('/api/decision-models/models',json={'mode':'remote','base_url':'https://example.com'})
            assert response.status_code==403
    finally:
        _current_actor.reset(token)
        await service.close()


@pytest.mark.asyncio
async def test_catalog_search_only_lists_executable_models_without_network_or_config_changes(service):
    def forbidden(request): pytest.fail('reviewed catalog search must work offline')
    service.transport=httpx.MockTransport(forbidden)
    await service.configure({'mode':'remote','base_url':'https://example.com','model':'saved','api_key':'service-secret'})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()),base_url='http://host') as c:
        rows=(await c.get('/api/decision-models/catalog/search')).json()['models']
        assert len(rows)==10
        assert all(row['supported'] and row['managed_model'] for row in rows)
        assert {'laya','laya-multilingual','laya-typed-decisions','d1-2b-q4','kev-4b-q4'}.issubset({row['managed_model'] for row in rows})
        assert len((await c.get('/api/decision-models/catalog/search',params={'q':'d1'})).json()['models'])==4
        chinese=(await c.get('/api/decision-models/catalog/search',params={'q':'中文'})).json()['models']
        assert any(row['managed_model']=='laya-multilingual' for row in chinese)
        assert (await service.snapshot())['settings']['model']=='saved'
    await service.close()
