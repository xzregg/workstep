"""pydantic-ai-harness 扩展：上下文压缩（TieredCompaction/WarnNearLimits）与会话持久化（StepPersistence）。"""

import pytest

from engines.pydantic_ai import PydanticAIEngine


def test_harness_extension_off_by_config(monkeypatch):
    from services import config as config_module

    monkeypatch.setattr(
        config_module.config_store,
        "get_pydantic_ai_engine_config",
        lambda: {"harness": "off"},
    )
    engine = PydanticAIEngine()
    assert engine._harness_enabled() is False
    assert engine._harness_capabilities(None, "sess-1") is None


def test_harness_extension_capabilities_attached(tmp_path):
    engine = PydanticAIEngine()
    caps = engine._harness_capabilities(tmp_path, "sess-1")
    assert caps is not None
    assert [type(c).__name__ for c in caps] == [
        "TieredCompaction",
        "WarnNearLimits",
        "StepPersistence",
    ]


@pytest.mark.anyio
async def test_harness_continue_history_none_without_snapshot(tmp_path):
    engine = PydanticAIEngine()
    assert await engine._harness_continue_history(tmp_path, "sess-1") is None


@pytest.mark.anyio
async def test_compaction_receipt_emits_compacted_event():
    from pydantic_ai_harness.compaction._receipts import (
        ReceiptInfo,
        open_receipt_scope,
        record_receipt,
    )

    engine = PydanticAIEngine()
    events = []

    async def record(event):
        events.append(event)

    scope = open_receipt_scope()
    record_receipt(ReceiptInfo(
        strategy="SlidingWindowCompaction",
        dropped_messages=42,
        dropped_tokens=12345,
        by="workstep",
        handle=None,
    ))
    await engine._drain_compaction_receipts(scope, record)

    assert len(events) == 1
    assert events[0].type == "compacted"
    assert "42" in (events[0].data.get("summary") or "")


@pytest.mark.anyio
async def test_tiered_compaction_triggers_once_when_history_crosses_small_window():
    from pydantic_ai import ModelRequestContext, RunContext, RunUsage
    from pydantic_ai.messages import ModelRequest, UserPromptPart
    from pydantic_ai.models import ModelRequestParameters
    from pydantic_ai.models.test import TestModel
    from pydantic_ai_harness.compaction import TieredCompaction
    calls = []
    class KeepLatest:
        async def compact(self, messages, ctx):
            calls.append(1)
            return messages[-1:]

    model = TestModel()
    request = ModelRequestContext(
        model=model,
        messages=[
            ModelRequest(parts=[UserPromptPart(content="a" * 500)]),
            ModelRequest(parts=[UserPromptPart(content="b" * 500)]),
        ],
        model_settings=None,
        model_request_parameters=ModelRequestParameters(),
    )
    context = RunContext(deps=None, model=model, usage=RunUsage())
    capability = TieredCompaction(
        tiers=[KeepLatest()], target_tokens=10, tokenizer=lambda text: len(text)
    )
    compacted = await capability.before_model_request(context, request)
    assert len(compacted.messages) == 1
    assert len(calls) == 1


@pytest.mark.anyio
async def test_run_agent_passes_conversation_id_when_harness_on(monkeypatch, tmp_path):
    from pydantic_ai.models.test import TestModel

    captured = {}

    class FakeResult:
        usage = None

        def all_messages(self):
            return []

    async def fake_stream(
        self,
        agent,
        *,
        prompt,
        on_event,
        message_history=None,
        model_settings=None,
        conversation_id=None,
    ):
        captured["conversation_id"] = conversation_id
        return FakeResult()

    monkeypatch.setattr(PydanticAIEngine, "_stream_agent_run", fake_stream)
    engine = PydanticAIEngine()
    await engine._run_agent(
        prompt="问题",
        cwd=str(tmp_path),
        add_dirs=None,
        model=TestModel(),
        on_event=lambda event: None,
        session_id="sess-1",
    )
    assert captured["conversation_id"] == "sess-1"


def test_acp_events_declares_compacted():
    assert "compacted" in PydanticAIEngine().acp_events
