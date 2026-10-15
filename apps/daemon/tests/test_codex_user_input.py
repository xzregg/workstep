import asyncio

import pytest

from engines.codex_sdk import CodexSDKEngine


@pytest.mark.anyio
@pytest.mark.parametrize("action", ["accept", "decline", "cancel"])
async def test_codex_native_form_uses_acp_and_returns_array_answers(action):
    engine = CodexSDKEngine()
    queue = asyncio.Queue()
    handler = engine._build_approval_handler(queue, asyncio.get_running_loop(), "session")
    form = {"type": "object", "required": ["features"], "properties": {
        "features": {"type": "array", "title": "功能范围", "items": {"anyOf": [
            {"const": "web", "title": "前端"}, {"const": "daemon", "title": "后端"},
        ]}},
    }}
    waiting = asyncio.create_task(asyncio.to_thread(handler, "mcpServer/elicitation/request", {
        "threadId": "session", "serverName": "tools", "mode": "form",
        "message": "选择实现范围", "requestedSchema": form,
    }))
    try:
        request = await asyncio.wait_for(queue.get(), 2)
        assert request.type == "interaction_request"
        assert request.data["method"] == "elicitation/create"
        assert request.data["requested_schema"] == form
        # The SDK reader thread waits while the event loop can still respond.
        await asyncio.wait_for(asyncio.sleep(0), 0.1)
        assert not waiting.done()
        response = {"action": action}
        if action == "accept":
            response["content"] = {"features": ["web", "daemon"]}
        await engine.respond_interaction(request.data, response)
        assert await asyncio.wait_for(waiting, 2) == {
            "action": action,
            "content": {"features": ["web", "daemon"]} if action == "accept" else None,
            "_meta": None,
        }
        assert not engine._pending_interaction_responses
    finally:
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)


@pytest.mark.anyio
async def test_codex_native_question_preserves_ids_and_uses_native_answer_envelope():
    engine = CodexSDKEngine()
    queue = asyncio.Queue()
    handler = engine._build_approval_handler(queue, asyncio.get_running_loop(), "session")
    waiting = asyncio.create_task(asyncio.to_thread(handler, "item/tool/requestUserInput", {
        "itemId": "ask", "threadId": "session", "questions": [{
            "id": "scope", "header": "范围", "question": "选择范围", "isOther": False,
            "options": [{"label": "前端", "description": "界面"}, {"label": "后端", "description": "服务"}],
        }],
    }))
    try:
        request = await asyncio.wait_for(queue.get(), 2)
        fields = request.data["requested_schema"]["properties"]
        assert list(fields) == ["scope"]
        assert fields["scope"]["type"] == "string"
        assert not fields["scope"]["_meta"]["allowInput"]
        await engine.respond_interaction(request.data, {"action": "accept", "content": {"scope": "前端"}})
        assert await asyncio.wait_for(waiting, 2) == {"answers": {"scope": {"answers": ["前端"]}}}
    finally:
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
