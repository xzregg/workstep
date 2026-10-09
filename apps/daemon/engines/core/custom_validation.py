"""Public engine acceptance suite distributed with WorkStep (no pytest needed)."""
import asyncio
from contextlib import suppress
import io
import json
import tempfile
import unittest

from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import InternalEvent
from engines.core.custom_package import declared_events
from services.config import config_store

CONTENT_KEYS = {
    "agent_message_chunk": "content", "agent_thought_chunk": "content", "user_message_chunk": "content",
    "tool_call": "tool_call_id", "tool_call_update": "tool_call_id",
    "interaction_request": "interaction_id", "session_started": "session_id", "error": "message",
}


def check_event(event, declared):
    if not isinstance(event, InternalEvent) or event.type not in declared or not isinstance(event.data, dict):
        raise AssertionError("事件类型或声明不一致")
    key = CONTENT_KEYS.get(event.type)
    if key and key not in event.data:
        raise AssertionError(f"事件缺少字段：{event.type}.{key}")
    if event.type in {"agent_message_chunk", "agent_thought_chunk", "user_message_chunk"}:
        if not isinstance(event.data["content"], dict) or not isinstance(event.data["content"].get("text"), str):
            raise AssertionError("文本事件必须携带 content.text")
    if event.type == "tool_call_update" and event.data.get("status") not in {"pending", "in_progress", "completed", "failed"}:
        raise AssertionError("工具事件状态无效")
    if event.type == "usage_update":
        for name in ("input_tokens", "output_tokens", "total_tokens"):
            value = event.data.get(name)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0):
                raise AssertionError("用量字段无效")
    payload = {**event.to_dict(), "engine": "custom_validation", "task_id": "validation",
               "session_id": "validation", "message_id": "validation", "channel": "validation"}
    list(to_agui_events(payload, AGUIContext.from_event(payload)))
    json.dumps(payload, allow_nan=False)


async def validate_adapter(engine, root, manifest):
    results = []
    observed = set()
    session_ids = []
    caps = engine.capabilities

    async def check(name, action, *, applicable=True):
        if not applicable:
            results.append({"name": name, "status": "not_applicable"})
            return
        try:
            await asyncio.wait_for(action(), 120)
            results.append({"name": name, "status": "passed"})
        except Exception as exc:
            # Arbitrary adapter errors/output are deliberately not persisted.
            results.append({"name": name, "status": "failed", "error": type(exc).__name__})

    async def turn(prompt, cwd, *, coordinator=False, **kwargs):
        chunks = []
        function = engine.spawn_coordinator if coordinator else engine.spawn
        kwargs.setdefault("model", config_store.get_engine_default_model(engine.ENGINE_ID) or None)
        provider = config_store.get_engine_provider(engine.ENGINE_ID)
        kwargs.setdefault("config_overrides", {"provider_id": provider} if provider else {})
        async for event in function(prompt=prompt, cwd=cwd, **kwargs):
            check_event(event, declared_events(engine))
            observed.add(event.type)
            if event.type == "error":
                raise AssertionError("引擎返回错误")
            if event.type == "interaction_request":
                # Acceptance prompts prohibit tools; do not approve unknown work.
                await engine.respond_interaction(event.data, {"outcome": {"outcome": "cancelled"}})
                raise AssertionError("无工具探测不应请求审批")
            if coordinator and event.type in {"tool_call", "tool_call_update"}:
                raise AssertionError("只读协调测试产生工具调用")
            if event.type == "session_started":
                session_ids.append(event.data["session_id"])
            if event.type == "agent_message_chunk":
                chunks.append(event.data["content"]["text"])
        text = "".join(chunks)
        if not text.strip():
            raise AssertionError("没有实际文本回复")
        return text

    with tempfile.TemporaryDirectory(prefix="workstep-engine-validation-") as temporary:
        cwd = temporary

        async def environment():
            assert engine.is_installed(), "依赖未安装"
            assert engine.is_configured(), "配置未完成"
            assert not manifest["id"] in {"codex", "claude", "pydantic_ai", "hermes"}

        async def idle_methods():
            # All methods must be safely callable with no active process.
            await engine.stop()
            await engine.stop()
            await engine.close_session("validation-inactive", cwd)
            await engine.cancel_session("validation-inactive", cwd)
            await engine.approve_tool("validation-inactive", False)
            await engine.approve_tool_option("validation-inactive", None)
            if not caps.supports_sessions:
                assert await engine.create_session(cwd) is None
                assert await engine.resume_session("validation-inactive", cwd) is False
                await engine.set_config_option("model", "validation", None)
                await engine.reset_options(None)

        async def conversation():
            await turn("Reply with WORKSTEP_ENGINE_OK only. Do not use tools or modify files.", cwd)

        async def coordinator():
            await turn("Reply with WORKSTEP_ENGINE_OK only.", cwd, coordinator=True)

        async def workflow():
            # Use the adapter's common seam for execute → downstream → review,
            # and verify every emitted event through the public translator.
            first = await turn("Return a short plan without tools or file changes.", cwd)
            second = await turn(f"Summarize this upstream result without tools: {first}", cwd)
            await turn(f"Review this result without tools: {second}", cwd,
                       coordinator=caps.supports_coordinator)

        async def resume():
            assert session_ids, "未返回会话 ID"
            sid = session_ids[-1]
            assert await engine.resume_session(sid, cwd) is True
            await turn("Reply with WORKSTEP_ENGINE_OK only. Do not use tools.", cwd, session_id=sid)

        async def sessions():
            sid = await engine.create_session(cwd)
            # Some transports create sessions only on the first prompt.
            if sid is None:
                assert session_ids
                sid = session_ids[-1]
            assert isinstance(sid, str) and sid
            await engine.cancel_session(sid, cwd)
            await engine.close_session(sid, cwd)

        async def fork():
            assert session_ids
            sid = session_ids[-1]
            forked = await engine.fork_session(sid, cwd)
            assert isinstance(forked, str) and forked and forked != sid
            await engine.close_session(forked, cwd)

        async def cancellation():
            # Start a real stream, then stop from another coroutine; transport
            # cleanup is also tested by the daemon's process-tree canaries.
            task = asyncio.create_task(turn("WORKSTEP_STOP_PROBE: Produce a long numbered list until stopped. Do not use tools or modify files.", cwd))
            try:
                await asyncio.sleep(.1)
                await asyncio.wait_for(engine.stop(), 5)
                with suppress(asyncio.CancelledError):
                    await asyncio.wait_for(asyncio.shield(task), 5)
                await engine.stop()
            finally:
                if not task.done():
                    task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await task

        async def dedicated_tests():
            def run():
                suite = unittest.defaultTestLoader.discover(str(root / "tests"), pattern="test_*.py")
                if suite.countTestCases() == 0:
                    raise AssertionError("需要引擎专属测试")
                output = io.StringIO()
                result = unittest.TextTestRunner(stream=output).run(suite)
                assert result.wasSuccessful()
            await asyncio.to_thread(run)

        async def capability_scenarios():
            # Optional features require real scenarios, not a boolean declaration.
            required = {
                "supports_tool_approval": "interaction_request", "supports_vision": "agent_message_chunk",
                "supports_live_step_message": "live_message", "supports_native_schema": "agent_message_chunk",
                "supports_workstep_tools": "tool_call", "supports_thinking_effort": "agent_message_chunk",
                "supports_plan_mode": "plan", "supports_goal_mode": "goal_update",
            }
            active = {name: event for name, event in required.items() if getattr(caps, name, False)}
            if not active:
                return
            file = root / "tests" / "scenarios.json"
            if not file.is_file():
                raise AssertionError("声明的可选能力需要 tests/scenarios.json")
            scenarios = await asyncio.to_thread(lambda: json.loads(file.read_text()))
            for capability, expected in active.items():
                scenario = scenarios.get(capability)
                if not isinstance(scenario, dict) or not scenario.get("prompt"):
                    raise AssertionError("缺少声明能力的真实探测")
                kwargs = dict(scenario.get("kwargs") or {})
                seen = set()
                if "live_messages" in scenario:
                    queue = asyncio.Queue()
                    for item in scenario["live_messages"]:
                        await queue.put(item)
                    kwargs["live_message_queue"] = queue
                if "images" in kwargs:
                    from engines.core.schema import EngineImage
                    from engines.core.custom_package import safe_file
                    kwargs["images"] = [EngineImage(path=str(safe_file(root, item))) for item in kwargs["images"]]
                chunks = []
                async for event in engine.spawn(prompt=scenario["prompt"], cwd=cwd, **kwargs):
                    check_event(event, declared_events(engine))
                    observed.add(event.type)
                    seen.add(event.type)
                    if event.type == "error":
                        raise AssertionError("能力探测失败")
                    if event.type == "interaction_request":
                        await engine.respond_interaction(event.data, {"outcome": {"outcome": "cancelled"}})
                    if event.type == "agent_message_chunk":
                        chunks.append(event.data["content"]["text"])
                assert expected in seen
                if capability == "supports_native_schema":
                    assert isinstance(json.loads("".join(chunks)), dict)

        await check("environment", environment)
        await check("idle_lifecycle_and_fallback", idle_methods)
        await check("adapter_unit_tests", dedicated_tests)
        await check("real_connection_and_event_translation", conversation)
        await check("coordinator_no_tools", coordinator, applicable=caps.supports_coordinator)
        await check("execute_downstream_review", workflow)
        await check("resume", resume, applicable=caps.supports_resume)
        await check("sessions", sessions, applicable=caps.supports_sessions)
        await check("fork", fork, applicable=caps.supports_session_fork)
        await check("declared_capability_scenarios", capability_scenarios)
        await check("stop_and_idempotency", cancellation)
    await engine.stop()
    return {"ok": all(item["status"] in {"passed", "not_applicable"} for item in results),
            "checks": results, "observed_events": sorted(observed),
            "declared_events": sorted(declared_events(engine)), "api_version": 1}
