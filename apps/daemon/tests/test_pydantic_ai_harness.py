"""pydantic-ai-harness 扩展：上下文压缩（TieredCompaction/WarnNearLimits）与会话持久化（StepPersistence）。"""

import asyncio
import time
from types import SimpleNamespace

import pytest

from engines.pydantic_ai import PydanticAIEngine
from engines.pydantic_ai.coder import WorkStepFileSystem, WorkStepShell


def test_harness_lifecycle_has_one_owner():
    from engines.pydantic_ai.harness_runtime import PydanticAIHarnessRuntime

    assert isinstance(PydanticAIEngine(), PydanticAIHarnessRuntime)
    assert "_harness_capabilities" not in PydanticAIEngine.__dict__


@pytest.mark.asyncio
async def test_coder_file_reads_do_not_block_the_event_loop(tmp_path, monkeypatch):
    target = tmp_path / "large.txt"
    target.write_text("content", encoding="utf-8")
    toolset = WorkStepFileSystem(root_dir=tmp_path).get_toolset()
    original_read_bytes = type(target).read_bytes

    def slow_read(path):
        time.sleep(0.25)
        return original_read_bytes(path)

    monkeypatch.setattr(type(target), "read_bytes", slow_read)
    started = time.perf_counter()
    read_task = asyncio.create_task(toolset.read_file("large.txt"))
    await asyncio.sleep(0.02)
    elapsed = time.perf_counter() - started
    result = await read_task

    assert "content" in result
    assert elapsed < 0.15


@pytest.mark.asyncio
async def test_background_command_output_read_does_not_block_event_loop(
    tmp_path, monkeypatch
):
    toolset = WorkStepShell(cwd=tmp_path).get_toolset()
    toolset._background["probe"] = SimpleNamespace(
        proc=SimpleNamespace(returncode=None),
        finished=False,
        exit_code=None,
    )

    def slow_output(_background):
        time.sleep(0.25)
        return "stdout", ""

    monkeypatch.setattr(toolset, "_read_bg_output", slow_output)
    started = time.perf_counter()
    output_task = asyncio.create_task(toolset.check_command("probe"))
    await asyncio.sleep(0.02)
    elapsed = time.perf_counter() - started
    result = await output_task

    assert "stdout" in result
    assert elapsed < 0.15


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
        "ConversationSearch",
    ]


def test_harness_tiered_compaction_stack(tmp_path):
    engine = PydanticAIEngine()
    caps = engine._harness_capabilities(tmp_path, "sess-1")
    tiered = next(c for c in caps if type(c).__name__ == "TieredCompaction")
    assert [type(t).__name__ for t in tiered.tiers] == [
        "ClearToolResults",
        "SlidingWindowCompaction",
        "SummarizingCompaction",
    ]
    sliding = next(
        t for t in tiered.tiers if type(t).__name__ == "SlidingWindowCompaction"
    )
    assert sliding.keep_messages == 60


def test_harness_summarizer_uses_fast_model(tmp_path, monkeypatch):
    from services import config as config_module

    monkeypatch.setattr(
        config_module.config_store,
        "get_pydantic_ai_engine_config",
        lambda: {
            "provider_id": "prov_1",
            "model": "main-model",
            "fast_model": "fast-model",
            "mcp_servers": [],
            "harness": "auto",
            "sandbox": "workspace-write",
        },
    )
    monkeypatch.setattr(
        config_module.config_store,
        "get_provider",
        lambda provider_id: {
            "id": "prov_1",
            "type": "openai",
            "protocol": "openai",
            "base_url": "https://api.example.com/v1",
            "api_key": "k",
        }
        if provider_id == "prov_1"
        else None,
    )
    monkeypatch.setattr(
        PydanticAIEngine,
        "build_model",
        staticmethod(
            lambda *, provider, model_name, protocol=None: type(
                "FakeModel", (), {"model_name": model_name}
            )()
        ),
    )
    engine = PydanticAIEngine()
    caps = engine._harness_capabilities(tmp_path, "sess-1")
    tiered = next(c for c in caps if type(c).__name__ == "TieredCompaction")
    summarizing = next(
        t for t in tiered.tiers if type(t).__name__ == "SummarizingCompaction"
    )
    assert summarizing.model is not None
    assert summarizing.model.model_name == "fast-model"


def test_harness_summarizer_falls_back_to_run_model(tmp_path, monkeypatch):
    from services import config as config_module

    monkeypatch.setattr(
        config_module.config_store,
        "get_pydantic_ai_engine_config",
        lambda: {
            "provider_id": "prov_1",
            "model": "main-model",
            "fast_model": "",
            "mcp_servers": [],
            "harness": "auto",
            "sandbox": "workspace-write",
        },
    )
    engine = PydanticAIEngine()
    caps = engine._harness_capabilities(tmp_path, "sess-1")
    tiered = next(c for c in caps if type(c).__name__ == "TieredCompaction")
    summarizing = next(
        t for t in tiered.tiers if type(t).__name__ == "SummarizingCompaction"
    )
    assert summarizing.model is None


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
@pytest.mark.parametrize("system_prompt", [None, "Channel role"])
async def test_run_agent_uses_harness_capabilities_without_private_memory(
    monkeypatch,
    tmp_path,
    system_prompt,
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
        captured["prompt"] = prompt
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
        system_prompt=system_prompt,
    )

    assert captured["prompt"] == "问题"
    assert [item.instruction for item in captured["agent"]._instructions] == (
        [system_prompt] if system_prompt else []
    )

    capabilities = captured["capabilities"]
    capability_names = [type(capability).__name__ for capability in capabilities]
    assert capability_names[2:12] == [
        "WorkStepFileSystem",
        "WorkStepShell",
        "RepoContext",
        "Planning",
        "SubAgents",
        "ClearToolResults",
        "WarnNearLimits",
        "ToolOutputLimits",
        "Skills",
        "Thinking",
    ]
    assert "WebSearch" in capability_names
    assert "WebFetch" in capability_names
    assert "Memory" not in capability_names
    # WebSearch / WebFetch 强制本地模式：不调用供应商原生工具
    for capability in capabilities:
        if type(capability).__name__ in ("WebSearch", "WebFetch"):
            assert capability.native is False
            assert capability.local is not None
    # ConversationSearch 与 StepPersistence 共享同一 SqliteStepStore，
    # 且 scope 限定 conversation
    step_persistence = next(
        capability for capability in capabilities
        if type(capability).__name__ == "StepPersistence"
    )
    conversation_search = next(
        capability for capability in capabilities
        if type(capability).__name__ == "ConversationSearch"
    )
    assert conversation_search.scope == "conversation"
    assert conversation_search.source._store is step_persistence.store
    assert capabilities[2].root_dir == tmp_path
    # 项目记忆对模型只读：写入会被 FileSystem 拒绝
    assert ".workstep/MEMORY.md" in capabilities[2].protected_patterns
    assert {"yarn", "npm", "npx", "node"}.issubset(
        set(capabilities[3].allowed_commands)
    )
    assert capabilities[10].directories == (tmp_path / ".workstep" / "skills",)
    assert capabilities[11].effort == "high"
    assert captured["agent"]._max_tool_retries == 3
    assert captured["agent"]._max_output_retries == 1
    assert captured["model_settings"] is None
    # Existing harness instructions remain; only opted-in callers add a role.
    if not system_prompt:
        assert captured["agent"]._instructions == []


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("effort", "expect_thinking", "expected_level"),
    [
        # 「极简」= 关闭思考模式：仍挂载 Thinking，但 effort=False
        # → ModelSettings(thinking=False)。
        ("minimal", True, False),
        # 自动 = 不强制，不挂载 Thinking capability。
        ("auto", False, None),
        ("low", True, "low"),
    ],
)
async def test_run_agent_thinking_effort_minimal_disables_thinking(
    monkeypatch,
    tmp_path,
    effort,
    expect_thinking,
    expected_level,
):
    """Pydantic AI 引擎：极简 → thinking=False（关闭思考）；自动 → 不挂载。"""
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
        thinking_effort=effort,
    )

    thinking = next(
        (
            capability
            for capability in captured["capabilities"]
            if type(capability).__name__ == "Thinking"
        ),
        None,
    )
    assert (thinking is not None) is expect_thinking
    if thinking is not None:
        assert thinking.effort == expected_level


def test_instructions_deferred_to_harness():
    """宿主不再拼装 instructions：AGENTS.md/CLAUDE.md 由 harness RepoContext 注入。"""
    assert not hasattr(PydanticAIEngine, "_compose_instructions")

    from pydantic_ai_harness.coder import Coder

    assert any(
        type(capability).__name__ == "RepoContext"
        for capability in Coder(".").capabilities
    )


@pytest.mark.anyio
async def test_ask_user_accepts_json_encoded_options_and_emits_interaction(
    monkeypatch,
    tmp_path,
):
    """宽松模型把 options 写成 JSON 字符串时仍应展示提问卡片。"""
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel

    requests = 0
    interactions = []
    engine = PydanticAIEngine()

    async def model(messages, info):
        nonlocal requests
        requests += 1
        if requests == 1:
            yield {
                0: DeltaToolCall(
                    name="ask_user",
                    json_args=(
                        '{"question":"需要哪个功能？",'
                        '"options":"[\\"日期/日历相关功能\\",'
                        '\\"某个编号/序号功能\\",\\"我来详细描述\\"]",'
                        '"allow_input":true}'
                    ),
                    tool_call_id="ask-user-1",
                )
            }
        else:
            yield "收到"

    async def on_event(event):
        if event.type != "interaction_request":
            return
        interactions.append(event)
        await engine.respond_interaction(
            event.data,
            {"action": "accept", "content": {"answer": "我来详细描述"}},
        )

    monkeypatch.setattr(engine, "_harness_capabilities", lambda root, session_id: None)
    await engine._run_agent(
        prompt="需求不明确",
        cwd=str(tmp_path),
        add_dirs=None,
        model=FunctionModel(stream_function=model),
        on_event=on_event,
    )

    assert len(interactions) == 1
    answer = interactions[0].data["requested_schema"]["properties"]["answer"]
    assert [choice["title"] for choice in answer["oneOf"]] == [
        "日期/日历相关功能",
        "某个编号/序号功能",
        "我来详细描述",
    ]


@pytest.mark.anyio
async def test_pydantic_agent_delivers_message_queued_during_active_run(
    monkeypatch,
    tmp_path,
):
    """执行中的用户消息应在当前 Pydantic 会话内开启下一轮。"""
    import asyncio

    from pydantic_ai.models.function import FunctionModel

    first_run_started = asyncio.Event()
    finish_first_run = asyncio.Event()
    requests = 0
    events = []
    queue = asyncio.Queue()
    engine = PydanticAIEngine()

    async def model(messages, info):
        nonlocal requests
        requests += 1
        if requests == 1:
            first_run_started.set()
            await finish_first_run.wait()
            yield "第一段"
        else:
            yield "第二段"

    async def on_event(event):
        events.append(event)

    monkeypatch.setattr(engine, "_harness_capabilities", lambda root, session_id: None)
    run = asyncio.create_task(engine._run_agent(
        prompt="开始",
        cwd=str(tmp_path),
        add_dirs=None,
        model=FunctionModel(stream_function=model),
        on_event=on_event,
        live_message_queue=queue,
    ))
    await first_run_started.wait()
    await queue.put(("insert-1", "补充消息"))
    finish_first_run.set()
    await run

    assert requests == 2
    assert any(
        event.type == "live_message"
        and event.data == {
            "message_id": "insert-1",
            "status": "delivered",
            "detail": "",
        }
        for event in events
    )


@pytest.mark.anyio
async def test_coder_rejected_commands_do_not_exhaust_tool_retries(tmp_path):
    from pydantic_ai import Agent
    from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
    from pydantic_ai.models.function import FunctionModel

    from engines.pydantic_ai.coder import WorkStepCoder

    requests = 0

    async def model(messages, info):
        nonlocal requests
        requests += 1
        if requests <= 4:
            return ModelResponse(parts=[ToolCallPart(
                "run_command",
                {"command": "bash -c 'echo blocked'"},
                tool_call_id=f"blocked-{requests}",
            )])
        return ModelResponse(parts=[TextPart("recovered")])

    agent = Agent(
        FunctionModel(function=model),
        capabilities=[WorkStepCoder(tmp_path, allowed_commands=("echo",))],
        retries={"tools": 3, "output": 1},
    )

    result = await agent.run("keep trying")

    assert requests == 5
    assert result.output == "recovered"
    assert sum(
        "Command 'bash' is not in the allowed list." in str(part.content)
        for message in result.all_messages()
        for part in message.parts
        if hasattr(part, "content")
    ) == 4


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
async def test_pydantic_stream_preserves_provider_phase_across_text_deltas():
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from pydantic_ai.messages import PartStartEvent, PartDeltaEvent, TextPart, TextPartDelta

    class AgentStream:
        @asynccontextmanager
        async def run_stream_events(self, prompt, **kwargs):
            async def events():
                for item_id, phase, first, delta in [
                    ("progress", "commentary", "我先", "定位。"),
                    ("answer", "final_answer", "已", "完成。"),
                    ("legacy", None, "普通", "回复。"),
                ]:
                    yield PartStartEvent(index=0, part=TextPart(
                        first, id=item_id, provider_name="openai",
                        provider_details={"phase": phase} if phase else None,
                    ))
                    yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta=delta))
                yield SimpleNamespace(event_kind="agent_run_result", result=SimpleNamespace(output="完成"))
            yield events()

    published = []

    async def record(event):
        published.append(event)

    await PydanticAIEngine()._stream_agent_run(AgentStream(), prompt="检查", on_event=record)
    assert [(event.data.get("phase"), event.data.get("source_item_id"), event.data["content"]["text"])
            for event in published] == [
        ("commentary", "progress", "我先"), ("commentary", "progress", "定位。"),
        ("final_answer", "answer", "已"), ("final_answer", "answer", "完成。"),
        ("final_answer", "legacy", "普通"), ("final_answer", "legacy", "回复。"),
    ]


@pytest.mark.anyio
async def test_harness_store_bounded_snapshots(tmp_path):
    """max_snapshots_per_run=1：超出保留集的旧快照在每次写入后被修剪。"""
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
    assert count == 1


# --- 子 agent 事件转发（对齐其他引擎） ---


def test_coder_injects_subagent_progress_capability():
    """WorkStepCoder 将整个运行的观察器注入所有子代理。"""
    from pydantic_ai_harness.subagents import SubAgents

    from engines.pydantic_ai.coder import WorkStepCoder

    async def on_event(event):
        pass

    progress = PydanticAIEngine()._make_subagent_capability(on_event)

    coder = WorkStepCoder(
        ".",
        allowed_commands=["git"],
        subagent_capability=progress,
    )
    subagents = [c for c in coder.capabilities if isinstance(c, SubAgents)]
    assert subagents, "WorkStepCoder should include a SubAgents capability"
    assert progress in subagents[0].shared_capabilities
    # 保留原有子 agent（explorer）
    assert "explorer" in subagents[0]._by_name
    # _instruction_sources 同步替换为新实例，避免 CombinedCapability._rebound 断言失败
    assert subagents[0] in coder._instruction_sources


def test_coder_without_handler_keeps_default():
    """不传 handler 时 SubAgents 保持原样。"""
    from pydantic_ai_harness.subagents import SubAgents

    from engines.pydantic_ai.coder import WorkStepCoder

    coder = WorkStepCoder(".", allowed_commands=["git"])
    subagents = [c for c in coder.capabilities if isinstance(c, SubAgents)]
    assert subagents
    assert subagents[0].event_stream_handler is None


@pytest.mark.anyio
async def test_subagent_events_persist_and_readable(tmp_path):
    """subagent 事件写入 JSONL 后可通过 timeline 读取（刷新后可见）。"""
    from agent_assistants.event_journal import TurnEventJournal
    from engines.core.events import InternalEvent
    from engines.core.plans import subagent_event

    workstep_dir = tmp_path
    journal = TurnEventJournal()
    ref = journal.start(workstep_dir, "session-test", "message-test")
    for ev in [
        InternalEvent(type="message_started", data={"role": "assistant"}),
        subagent_event(
            task_id="subagent-explorer", status="running", stage="started",
            description="Explore",
        ),
        subagent_event(
            task_id="subagent-explorer", status="running", stage="progress",
            last_tool_name="read_file",
        ),
        subagent_event(
            task_id="subagent-explorer", status="completed", stage="finished",
            last_tool_name="read_file",
        ),
    ]:
        journal.record(ref, {"type": ev.type, "data": ev.data})
    journal.finish(ref)

    result = journal.timeline(ref, cursor=0, limit=30000)
    subagent_events = [e for e in result["events"] if e["type"] == "subagent"]
    assert len(subagent_events) == 3
    assert subagent_events[0]["data"]["stage"] == "started"
    assert subagent_events[-1]["data"]["status"] == "completed"


# --- Planning 工具集 → ACP plan 快照（前端 PlanChecklist 渲染兼容） ---


def test_coder_pins_planning_store(tmp_path):
    """WorkStepCoder 固定 Planning 的 InMemoryPlanStore 并暴露给宿主引擎。"""
    from pydantic_ai_harness.planning import InMemoryPlanStore, Planning

    from engines.pydantic_ai.coder import WorkStepCoder

    coder = WorkStepCoder(tmp_path, allowed_commands=["git"])
    planning = [c for c in coder.capabilities if isinstance(c, Planning)]
    assert planning, "WorkStepCoder should include a Planning capability"
    assert isinstance(coder.plan_store, InMemoryPlanStore)
    assert planning[0].store is coder.plan_store
    # _instruction_sources 与替换后的 capability 保持同一对象
    assert planning[0] in coder._instruction_sources


@pytest.mark.anyio
async def test_publish_plan_snapshot_emits_and_dedupes():
    """_publish_plan_snapshot 发 plan 事件、去重、并归一化 harness 状态。"""
    from pydantic_ai_harness.planning import InMemoryPlanStore
    from pydantic_ai_harness.planning._types import (
        PlanItem,
        TaskStatus,
    )

    engine = PydanticAIEngine()
    store = InMemoryPlanStore()
    engine._active_plan_store = store
    engine._last_plan_snapshot = None
    events: list = []

    async def record(event):
        events.append(event)

    await store.set_items([
        PlanItem(id="a1", content="第一步", status=TaskStatus.in_progress,
                 active_form="正在做第一步"),
        PlanItem(id="b2", content="第二步", status=TaskStatus.blocked),
        PlanItem(id="c3", content="已取消", status=TaskStatus.cancelled),
    ])
    await engine._publish_plan_snapshot(record)
    await engine._publish_plan_snapshot(record)  # 无变化 → 去重
    assert len(events) == 1
    entries = events[0].data["entries"]
    assert events[0].type == "plan"
    by_content = {e["content"]: e for e in entries}
    # blocked → pending、cancelled → completed（ACP 稳定三态）
    assert by_content["第一步"]["status"] == "in_progress"
    assert by_content["第一步"]["detail"] == "正在做第一步"
    assert by_content["第二步"]["status"] == "pending"
    assert by_content["已取消"]["status"] == "completed"

    await store.update_item("a1", status=TaskStatus.completed)
    await engine._publish_plan_snapshot(record)
    assert len(events) == 2
    by_content = {e["content"]: e for e in events[1].data["entries"]}
    assert by_content["第一步"]["status"] == "completed"


@pytest.mark.anyio
async def test_harness_planning_tools_publish_plan_snapshot(tmp_path):
    """模型调用 write_plan / update_task_status 后，引擎发布对应 plan 快照。"""
    import json as jsonlib

    from pydantic_ai import Agent
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel

    from engines.pydantic_ai.coder import WorkStepCoder

    requests = 0

    async def model(messages, info):
        nonlocal requests
        requests += 1
        if requests == 1:
            yield {
                0: DeltaToolCall(
                    name="write_plan",
                    json_args=jsonlib.dumps({
                        "items": [
                            {"id": "aaaa1111", "content": "实现功能",
                             "status": "pending"},
                            {"id": "bbbb2222", "content": "补测试",
                             "status": "pending"},
                        ],
                    }),
                    tool_call_id="wp-1",
                )
            }
        if requests == 2:
            yield {
                0: DeltaToolCall(
                    name="update_task_status",
                    json_args=jsonlib.dumps(
                        {"task_id": "aaaa1111", "status": "in_progress"}
                    ),
                    tool_call_id="ut-1",
                )
            }
        yield "完成"

    coder = WorkStepCoder(tmp_path, allowed_commands=["git"])
    agent = Agent(
        FunctionModel(stream_function=model),
        capabilities=[coder],
        retries={"tools": 3, "output": 1},
    )
    engine = PydanticAIEngine()
    engine._active_plan_store = coder.plan_store
    engine._last_plan_snapshot = None
    events: list = []

    async def record(event):
        events.append(event)

    result = await engine._stream_agent_run(
        agent, prompt="实现功能并补测试", on_event=record,
    )
    assert result.output == "完成"

    plan_events = [e for e in events if e.type == "plan"]
    assert len(plan_events) == 2
    first = {e["content"]: e["status"] for e in plan_events[0].data["entries"]}
    assert first == {"实现功能": "pending", "补测试": "pending"}
    second = {e["content"]: e["status"] for e in plan_events[1].data["entries"]}
    assert second == {"实现功能": "in_progress", "补测试": "pending"}
