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
async def test_harness_continue_history_skips_new_run_without_snapshot(tmp_path):
    from datetime import UTC, datetime, timedelta

    from pydantic_ai.messages import ModelRequest, UserPromptPart
    from pydantic_ai_harness.step_persistence import (
        ContinuableSnapshot,
        RunRecord,
    )

    engine = PydanticAIEngine()
    store = engine._harness_store(tmp_path)
    started_at = datetime.now(UTC)
    await store.register_run(RunRecord(
        run_id="workstep-with-history",
        conversation_id="sess-1",
        started_at=started_at,
    ))
    await store.save_snapshot(ContinuableSnapshot(
        run_id="workstep-with-history",
        step_index=1,
        conversation_id="sess-1",
        messages=[ModelRequest(parts=[UserPromptPart(content="previous work")])],
    ))
    await store.register_run(RunRecord(
        run_id="workstep-empty-retry",
        conversation_id="sess-1",
        started_at=started_at + timedelta(seconds=1),
    ))

    history = await engine._harness_continue_history(tmp_path, "sess-1")

    assert history is not None
    assert history[0].parts[0].content == "previous work"


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
        model=None,
        on_event=lambda event: None,
        session_id="sess-1",
    )
    assert captured["conversation_id"] == "sess-1"


@pytest.mark.anyio
async def test_run_agent_uses_harness_capabilities_without_private_memory(
    monkeypatch,
    tmp_path,
):
    skill_dir = tmp_path / ".workstep" / "skills" / "demo"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: demo\ndescription: Demo skill\n---\n\nUse the demo skill.\n",
        encoding="utf-8",
    )
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
        captured["agent"] = agent
        captured["capabilities"] = agent.root_capability.capabilities
        captured["model_settings"] = model_settings
        return FakeResult()

    monkeypatch.setattr(PydanticAIEngine, "_stream_agent_run", fake_stream)
    engine = PydanticAIEngine()
    await engine._run_agent(
        prompt="问题",
        cwd=str(tmp_path),
        add_dirs=None,
        model=None,
        on_event=lambda event: None,
        session_id="sess-1",
        thinking_effort="high",
    )

    capabilities = captured["capabilities"]
    capability_names = [type(capability).__name__ for capability in capabilities]
    assert capability_names[2:12] == [
        "FileSystem",
        "Shell",
        "RepoContext",
        "Planning",
        "SubAgents",
        "ClearToolResults",
        "WarnNearLimits",
        "ToolOutputLimits",
        "Skills",
        "Thinking",
    ]
    assert "WebSearch" not in capability_names
    assert "Memory" not in capability_names
    assert capabilities[2].root_dir == tmp_path
    assert capabilities[10].directories == (tmp_path / ".workstep" / "skills",)
    assert capabilities[11].effort == "high"
    assert captured["agent"]._max_tool_retries == 3
    assert captured["agent"]._max_output_retries == 1
    assert captured["model_settings"] is None


def test_acp_events_declares_compacted():
    assert "compacted" in PydanticAIEngine().acp_events


@pytest.mark.anyio
async def test_stream_agent_run_allows_more_than_fifty_model_requests():
    from pydantic_ai import Agent
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel

    requests = 0

    async def model(messages, info):
        nonlocal requests
        requests += 1
        if requests <= 50:
            yield {
                0: DeltaToolCall(
                    name="continue_work",
                    json_args="{}",
                    tool_call_id=f"continue-{requests}",
                )
            }
        else:
            yield "done"

    agent = Agent(FunctionModel(stream_function=model))

    @agent.tool_plain
    def continue_work() -> str:
        return "continue"

    async def ignore_event(event):
        return None

    engine = PydanticAIEngine()
    result = await engine._stream_agent_run(
        agent,
        prompt="complete a long coding task",
        on_event=ignore_event,
    )

    assert requests == 51
    assert result.output == "done"


@pytest.mark.anyio
async def test_harness_store_bounded_snapshots(tmp_path):
    """max_snapshots_per_run=30：超出保留集的旧快照在每次写入后被修剪。"""
    from pydantic_ai_harness.step_persistence import ContinuableSnapshot

    store = PydanticAIEngine._harness_store(tmp_path)
    for i in range(35):
        await store.save_snapshot(
            ContinuableSnapshot(run_id="workstep-abcd1234", step_index=i, messages=[])
        )
    conn = store._open()
    try:
        count = conn.execute(
            "SELECT COUNT(*) FROM snapshots WHERE run_id = 'workstep-abcd1234'"
        ).fetchone()[0]
    finally:
        conn.close()
    assert count == 30
