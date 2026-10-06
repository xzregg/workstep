from engines.codex_sdk import CodexSDKEngine
from engines.core.events import InternalEvent
from engines.core.plans import subagent_event


def test_shared_contract_preserves_prompt_and_freezes_lifecycle_times():
    engine = CodexSDKEngine()
    engine.normalize_event(InternalEvent(type="tool_call", data={
        "tool_call_id": "delegate", "title": "Agent",
        "raw_input": {"prompt": "真实任务指令"},
    }, timestamp=1000))
    started = engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "child", "tool_use_id": "delegate", "status": "running", "stage": "started",
    }, timestamp=2000))
    assert started.data["prompt"] == "真实任务指令"
    assert started.data["started_at"] == 2000
    ended = engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "child", "status": "completed", "stage": "finished", "summary": "结果",
    }, timestamp=5500))
    late = engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "child", "status": "completed", "stage": "progress",
    }, timestamp=9000))
    assert ended.data["result"] == "结果"
    assert late.data["started_at"] == 2000
    assert late.data["ended_at"] == 5500


def test_unknown_start_is_not_invented_and_provider_fields_are_preserved():
    event = subagent_event(task_id="child", status="completed", stage="finished",
                           agent_name="worker", agent_path="/root/worker", prompt="do work",
                           started_at=1000, ended_at=2000, result="done")
    normalized = CodexSDKEngine().normalize_event(event)
    assert normalized.data["agent_name"] == "worker"
    assert normalized.data["started_at"] == 1000
    assert normalized.data["ended_at"] == 2000
    missing = CodexSDKEngine().normalize_event(InternalEvent(type="subagent", data={
        "task_id": "unknown", "status": "completed", "stage": "finished",
    }, timestamp=4000))
    assert "started_at" not in missing.data
    assert "prompt" not in missing.data


def test_restart_uses_native_times_and_unknown_updates_keep_known_status():
    engine = CodexSDKEngine()
    engine.normalize_event(subagent_event(task_id="child", status="completed", stage="finished"))
    restarted = engine.normalize_event(subagent_event(
        task_id="child", status="running", stage="started", started_at=5000,
    ))
    assert restarted.data["started_at"] == 5000
    assert "ended_at" not in restarted.data
    updated = engine.normalize_event(subagent_event(task_id="child", status="updated", stage="updated"))
    assert updated.data["status"] == "running"
    assert updated.data["native_status"] == "updated"
