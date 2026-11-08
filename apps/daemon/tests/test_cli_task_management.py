"""Task lifecycle CLI contracts through the shared HTTP adapter."""
import json

import httpx
import pytest

from cli import main
from services.tool_registry import WorkstepClient

CASES = [
    ("update", ["--title", "新版", "--desc", "新描述"], "PATCH", "/api/task/t", {"title": "新版", "description": "新描述"}),
    ("copy", ["--title", "副本"], "POST", "/api/task/copy", {"task_id": "t", "newTitle": "副本"}),
    ("delete", ["--keep-workspace"], "DELETE", "/api/task/delete", {"task_id": "t", "delete_workspace": False}),
    ("delete", ["--delete-workspace"], "DELETE", "/api/task/delete", {"task_id": "t", "delete_workspace": True}),
    ("stop", [], "POST", "/api/task/cancel", {"task_id": "t"}),
    ("pause", [], "POST", "/api/task/pause", {"task_id": "t"}),
    ("archive", [], "POST", "/api/task/archive", {"task_id": "t"}),
    ("unarchive", [], "POST", "/api/task/unarchive", {"task_id": "t"}),
    ("retry", ["--message", "m"], "POST", "/api/task/t/messages/m/retry", {}),
    ("review-approve", ["--step", "A", "--review", "r", "--comment", "通过"], "POST", "/api/task/t/steps/A/review/approve", {"review_run_id": "r", "comment": "通过"}),
    ("review-reject", ["--step", "A", "--review", "r"], "POST", "/api/task/t/steps/A/review/reject", {"review_run_id": "r"}),
    ("archive-draft", [], "GET", "/api/task/t/archive-experience/draft", {}),
    ("archive-prepare", ["--message", "m", "--locale", "en-US"], "POST", "/api/task/t/archive-experience/prepare", {"locale": "en-US"}),
    ("archive-stop", ["--message", "m"], "POST", "/api/task/t/archive-experience/stop", {}),
    ("archive-confirm", ["--experience", ""], "POST", "/api/task/t/archive-experience/confirm", {"experience": ""}),
]

@pytest.mark.parametrize("action,extra,method,path,body", CASES)
def test_task_management_routes(capsys, action, extra, method, path, body):
    calls = []
    async def handler(request):
        calls.append(request)
        assert request.method == method
        assert request.url.path == path
        query = {"project_id": "remote:p"}
        if action in {"archive-prepare", "archive-stop"}:
            query["message_id"] = "m"
        if action == "archive-prepare":
            query["background"] = "true"
        assert dict(request.url.params) == query
        assert (json.loads(request.content) if request.content else {}) == body
        return httpx.Response(200, json={"result": "accepted"})
    assert main(["task", action, "--project", "remote:p", "--task", "t", *extra, "--json"],
                client=WorkstepClient(transport=httpx.MockTransport(handler))) == 0
    assert json.loads(capsys.readouterr().out) == {"result": "accepted"}
    assert len(calls) == 1

@pytest.mark.parametrize("action,extra", [("update", ["--desc", " "]), ("update", []), ("update", ["--title", "  "]), ("copy", ["--title", " "])])
def test_invalid_edits_never_send(capsys, action, extra):
    async def handler(request):
        pytest.fail("invalid edit sent")
    assert main(["task", action, "--project", "p", "--task", "t", *extra, "--json"],
                client=WorkstepClient(transport=httpx.MockTransport(handler))) == 1
    assert json.loads(capsys.readouterr().out)["ok"] is False

@pytest.mark.parametrize("status", [403, 409])
def test_archive_failure_does_not_fallback_or_retry(capsys, status):
    calls = []
    async def handler(request):
        calls.append(request.url.path)
        return httpx.Response(status, json={"detail": "not allowed"})
    assert main(["task", "archive-confirm", "--project", "p", "--task", "t", "--experience", "经验", "--json"],
                client=WorkstepClient(transport=httpx.MockTransport(handler))) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "not allowed"
    assert calls == ["/api/task/t/archive-experience/confirm"]

@pytest.mark.anyio
async def test_all_lifecycle_native_mutations_require_authorization():
    from task_management_cli import OPERATIONS
    from services.tool_registry import TOOL_BY_NAME
    async def handler(request):
        pytest.fail("unauthorized mutation sent")
    client = WorkstepClient(transport=httpx.MockTransport(handler))
    for operation in OPERATIONS.values():
        tool = TOOL_BY_NAME[operation]
        if tool.read_only:
            continue
        result = await client.call(operation, {key: "value" for key in tool.required})
        assert result["ok"] is False
        assert "confirm" in result["error"]


def test_background_prepare_preserves_pending_result(capsys):
    async def handler(request):
        return httpx.Response(202, json={"status": "running", "message_id": "m"})
    assert main(["task", "archive-prepare", "--project", "p", "--task", "t", "--message", "m", "--json"],
                client=WorkstepClient(transport=httpx.MockTransport(handler))) == 0
    assert json.loads(capsys.readouterr().out) == {"status": "running", "message_id": "m"}
