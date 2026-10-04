"""Managed provider selection through a saved workflow and task execution."""

import json
import time

import httpx
import pytest

from engines.codex import CodexEngine
from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from models import Task, TaskStep, init_db
from services import config as config_module
from services import providers as provider_service
from services import task_runner as task_runner_module
from services.task_runner import TaskRunner
from streaming.bus import EventBus


@pytest.mark.anyio
async def test_workflow_step_uses_explicit_provider_then_managed_default_on_pc(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    store.set_managed_gateway_id("gateway-test", provider_guard=lambda _id: True)
    store.apply_managed_providers("gateway-test", 1, [{
        "id": provider_id, "name": provider_id, "type": "custom",
        "protocols": ["openai_responses"],
        "protocol_base_urls": {"openai_responses": "https://supplier.example.test/v1"},
        "api_key": f"secret-{provider_id}", "models": ["model-a"],
    } for provider_id in ("managed-default", "managed-explicit")],
        default_provider_id="managed-default")
    monkeypatch.setattr(CodexEngine, "provider_config_store", classmethod(lambda cls: store))
    monkeypatch.setattr(task_runner_module, "config_store", store)
    requests = []

    async def respond(request):
        requests.append((str(request.url), dict(request.headers), json.loads(request.content)))
        return httpx.Response(200, json={"output_text": "completed"})

    class ManagedTextEngine(CodexEngine):
        async def spawn(self, prompt, cwd, model=None, session_id=None, config_overrides=None, **kwargs):
            runtime = self.resolve_provider_runtime(
                provider_id=(config_overrides or {}).get("provider_id"), model=model)
            provider = store.get_provider(runtime.provider_id)
            result = await provider_service.text_completion(
                provider, runtime.model, [{"role": "user", "content": prompt}],
                transport=httpx.MockTransport(respond))
            yield InternalEvent(type="session_started", data={"session_id": f"session-{runtime.provider_id}"})
            yield InternalEvent(type="agent_message_chunk", data={"content": {"text": result}})
            yield InternalEvent(type="status", data={"status": "done"})

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["codex"] = ManagedTextEngine
    db = init_db(str(tmp_path / "project.db"))
    try:
        task = Task.create(id="managed-task", title="Managed", cwd=str(tmp_path),
                           engine="codex", created_at=int(time.time()),
                           updated_at=int(time.time()))
        workflow = {"steps": [
            {"key": "explicit", "label": "Explicit", "engine": "codex", "model": "model-a",
             "prompt": "first", "config": {"provider_id": "managed-explicit"}},
            {"key": "default", "label": "Default", "engine": "codex", "model": "model-a",
             "prompt": "second", "dependsOn": ["explicit"]},
        ]}
        await TaskRunner(EventBus()).run_pipeline(task, workflow, tmp_path / "artifacts")
        assert [item[2]["model"] for item in requests] == ["model-a", "model-a"]
        assert [item[1]["authorization"] for item in requests] == [
            "Bearer secret-managed-explicit", "Bearer secret-managed-default"]
        assert all(item[0] == "https://supplier.example.test/v1/responses" for item in requests)
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "explicit")).session_provider == "managed-explicit"
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "default")).session_provider == "managed-default"
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()
    assert b"secret-managed-" not in (tmp_path / "project.db").read_bytes()
