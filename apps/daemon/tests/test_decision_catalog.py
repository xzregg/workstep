import asyncio
import hashlib
import json
import pytest
import httpx
from services.decision_models import DecisionModelService, TEST_PAYLOAD
from services.decision_resources import DecisionResources


@pytest.mark.asyncio
async def test_three_models_have_isolated_verified_downloads_and_delete(tmp_path, monkeypatch):
    import services.decision_catalog as catalog
    resources = DecisionResources(tmp_path)
    from services import decision_resources as resource_module
    original_client = httpx.AsyncClient
    for kind in ('english', 'typed-decisions'):
        entry = next(m for m in catalog.MODELS if m['resource_kind'] == kind)
        data = kind.encode()
        monkeypatch.setitem(entry, 'files', [('model.safetensors', len(data), hashlib.sha256(data).hexdigest())])
        seen = []
        def reply(request):
            seen.append(str(request.url))
            return httpx.Response(200, content=data)
        monkeypatch.setattr(resource_module.httpx, 'AsyncClient', lambda **kwargs: original_client(transport=httpx.MockTransport(reply), **kwargs))
        await resources.download(kind)
        await resources.task
        assert resources.installed(kind)
        assert seen == [entry['base_url'] + '/model.safetensors']
        resources.verify_model(kind)
    assert resources.path('english') != resources.path('typed-decisions')
    await resources.delete('english')
    assert resources.installed('typed-decisions')
    assert not resources.installed('english')
    assert not resources.installed('model')
    await resources.close()


@pytest.mark.asyncio
async def test_selection_persists_and_draft_test_uses_requested_model(tmp_path, monkeypatch):
    value = DecisionModelService(tmp_path)
    monkeypatch.setattr(value, '_environment', lambda *args: {'supported':True,'reasons':[]})
    monkeypatch.setattr(value.resources, 'installed', lambda kind: True)
    monkeypatch.setattr(value.resources, 'verify_model', lambda kind='model': None)
    seen = []
    async def infer(runtime, model, payload):
        seen.append(model.name)
        return {'answers': {'ready': {'noul': .9}}}
    monkeypatch.setattr(value.runtime, 'test', infer)
    await value.configure({'mode':'managed', 'managed_model':'laya'})
    await value.test({'mode':'managed', 'managed_model':'laya-typed-decisions'})
    assert seen == ['laya-typed-decisions']
    assert (await value.snapshot())['settings']['managed_model'] == 'laya'
    assert len((await value.snapshot())['models']) == 10
    await value.configure({'mode':'managed'})
    assert (await value.snapshot())['settings']['managed_model'] == 'laya'
    with pytest.raises(ValueError):
        await value.configure({'mode':'managed', 'managed_model':'../../other'})
    await value.close()


@pytest.mark.asyncio
async def test_worker_changes_process_when_selected_model_changes(tmp_path, monkeypatch):
    import sys
    from services.decision_runtime import DecisionRuntime
    script = tmp_path / 'worker.py'
    script.write_text('import sys,json,os\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({"id":r["id"],"result":{"pid":os.getpid()}}),flush=True)\n')
    original = asyncio.create_subprocess_exec
    async def spawn(*args, **kwargs): return await original(sys.executable, str(script), **kwargs)
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    runtime = DecisionRuntime()
    try:
        a = await runtime.test(tmp_path, tmp_path/'laya', TEST_PAYLOAD)
        b = await runtime.test(tmp_path, tmp_path/'laya', TEST_PAYLOAD)
        c = await runtime.test(tmp_path, tmp_path/'typed', TEST_PAYLOAD)
        assert a == b and a != c
    finally: await runtime.close()
