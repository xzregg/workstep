"""WorkStep daemon CLI contracts (argparse, dispatch mapping, output)."""

import json

import httpx
import pytest

from cli import build_parser, dispatch, main
from services.tool_registry import WorkstepClient


def test_parser_resolves_subcommands():
    parser = build_parser()

    args = parser.parse_args(["project", "list"])
    assert (args.command, args.subcommand) == ("project", "list")
    assert args.json is False

    args = parser.parse_args(
        ["project", "init", "/tmp/demo", "--name", "demo", "--json"]
    )
    assert (args.command, args.subcommand) == ("project", "init")
    assert args.path == "/tmp/demo"
    assert args.name == "demo"
    assert args.json is True

    args = parser.parse_args(["task", "list", "--project", "p1"])
    assert (args.command, args.subcommand) == ("task", "list")
    assert args.project_id == "p1"

    args = parser.parse_args(["task", "get", "--project", "p1", "--task", "t1"])
    assert (args.command, args.subcommand) == ("task", "get")
    assert args.task_id == "t1"
    args = parser.parse_args(["task", "worktree-add", "--project", "p1", "--task", "t1", "--repository", "r1", "--alias", "api"])
    assert (args.repository_id, args.alias, args.base_ref) == ("r1", "api", "HEAD")
    args = parser.parse_args(["task", "worktree-add", "--project", "p1", "--task", "t1", "--repository", "r1", "--alias", "api", "--base", "release", "--branch", "feature/api"])
    assert (args.base_ref, args.branch_name) == ("release", "feature/api")

    args = parser.parse_args(
        [
            "task", "create", "--project", "p1", "--title", "标题",
            "--cwd", "/w", "--desc", "说明", "--workflow", "w1",
            "--start-step", "research",
        ]
    )
    assert (args.command, args.subcommand) == ("task", "create")
    assert args.title == "标题"
    assert args.cwd == "/w"
    assert args.description == "说明"
    assert args.workflow_id == "w1"
    assert args.start_step_key == "research"

    args = parser.parse_args([
        "workflow", "action-create", "--project", "p1", "--workflow", "w1",
        "--action-id", "start-services", "--title", "启动服务",
        "--script-file", "/tmp/start.sh", "--cwd", "task", "--overwrite",
        "--input-prompt", "请输入 Commit 消息",
    ])
    assert (args.command, args.subcommand, args.action_id) == ("workflow", "action-create", "start-services")
    assert args.overwrite is True
    assert args.input_prompt == "请输入 Commit 消息"

    args = parser.parse_args([
        "project", "action-create", "--project", "p1",
        "--action-id", "restart", "--title", "重启服务",
        "--script-file", "/tmp/restart.sh",
    ])
    assert (args.command, args.subcommand, args.action_id) == ("project", "action-create", "restart")

    args = parser.parse_args(["project", "quick-buttons", "--project", "p1", "--json"])
    assert (args.command, args.subcommand, args.project_id, args.json) == ("project", "quick-buttons", "p1", True)

    args = parser.parse_args(["workflow", "quick-buttons", "--project", "p1", "--workflow", "w1", "--json"])
    assert (args.command, args.subcommand, args.workflow_id, args.json) == ("workflow", "quick-buttons", "w1", True)

    args = parser.parse_args(["workflow", "list", "--project", "p1"])
    assert (args.command, args.subcommand) == ("workflow", "list")

    args = parser.parse_args([
        "workflow", "get", "--project", "p1", "--workflow", "w1",
    ])
    assert (args.command, args.subcommand) == ("workflow", "get")
    assert args.workflow_id == "w1"

    args = parser.parse_args(["engine", "list"])
    assert (args.command, args.subcommand) == ("engine", "list")


@pytest.mark.anyio
async def test_dispatch_create_workflow_action_posts_script(tmp_path):
    script = tmp_path / "start.sh"
    script.write_text("#!/bin/bash\necho ready\n")
    captured = {}

    async def handler(request):
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["query"] = dict(request.url.params)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"action_id": "start-services"})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    result = await dispatch(build_parser().parse_args([
        "workflow", "action-create", "--project", "p1", "--workflow", "w1",
        "--action-id", "start-services", "--title", "启动服务",
        "--script-file", str(script), "--cwd", "task",
        "--input-prompt", "请输入 Commit 消息",
    ]), client)
    assert result["action_id"] == "start-services"
    assert (captured["method"], captured["path"]) == ("POST", "/api/workflow/w1/actions")
    assert captured["query"] == {"project_id": "p1"}
    assert captured["body"]["script_content"] == script.read_text()
    assert captured["body"]["require_confirmation"] is True
    assert captured["body"]["confirmation_input_prompt"] == "请输入 Commit 消息"


@pytest.mark.anyio
async def test_dispatch_overwrites_workflow_action_only_when_explicit(tmp_path):
    script = tmp_path / "start.sh"
    script.write_text("#!/bin/bash\necho updated\n")
    bodies = []

    async def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"overwritten": bodies[-1].get("overwrite", False)})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    base = ["workflow", "action-create", "--project", "p1", "--workflow", "w1",
            "--action-id", "start", "--title", "启动", "--script-file", str(script)]
    await dispatch(build_parser().parse_args(base), client)
    await dispatch(build_parser().parse_args([*base, "--overwrite"]), client)
    assert bodies[0]["overwrite"] is False
    assert bodies[1]["overwrite"] is True


@pytest.mark.anyio
async def test_dispatch_create_project_action_posts_script(tmp_path):
    script = tmp_path / "restart.sh"
    script.write_text("#!/bin/bash\necho restarted\n")
    captured = {}

    async def handler(request):
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"action_id": "restart"})

    result = await dispatch(build_parser().parse_args([
        "project", "action-create", "--project", "p1",
        "--action-id", "restart", "--title", "重启服务",
        "--script-file", str(script),
    ]), WorkstepClient(transport=httpx.MockTransport(handler)))
    assert result["action_id"] == "restart"
    assert (captured["method"], captured["path"]) == ("POST", "/api/projects/p1/actions")
    assert captured["body"]["script_content"] == script.read_text()


@pytest.mark.anyio
async def test_dispatch_reads_project_quick_buttons():
    async def handler(request):
        assert request.method == "GET"
        assert request.url.path == "/api/chat-sessions/quick-buttons"
        assert dict(request.url.params) == {"project_id": "p1"}
        return httpx.Response(200, json={"buttons": [{"id": "restart", "kind": "action", "label": "重启"}]})

    result = await dispatch(build_parser().parse_args([
        "project", "quick-buttons", "--project", "p1",
    ]), WorkstepClient(transport=httpx.MockTransport(handler)))
    assert result["buttons"][0]["id"] == "restart"


@pytest.mark.anyio
async def test_dispatch_reads_workflow_quick_buttons_with_selected_project_buttons():
    calls = []

    async def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/api/workflow/w1":
            return httpx.Response(200, json={"id": "w1", "steps": {
                "projectQuickButtonIds": ["restart"],
                "quickButtons": [{"id": "local", "kind": "display", "label": "说明"}],
                "nodes": [{"key": "build", "title": "开发", "quickButtons": [{"id": "stage", "kind": "prompt", "label": "检查"}]}],
            }})
        return httpx.Response(200, json={"buttons": [
            {"id": "restart", "kind": "action", "label": "重启"},
            {"id": "review", "kind": "prompt", "label": "评审"},
        ]})

    result = await dispatch(build_parser().parse_args([
        "workflow", "quick-buttons", "--project", "p1", "--workflow", "w1",
    ]), WorkstepClient(transport=httpx.MockTransport(handler)))
    assert calls == [("GET", "/api/workflow/w1"), ("GET", "/api/chat-sessions/quick-buttons")]
    assert [button["id"] for button in result["workflow_buttons"]] == ["local"]
    assert result["stage_buttons"][0]["step_key"] == "build"
    assert [button["id"] for button in result["inherited_project_buttons"]] == ["restart"]
    assert result["project_button_ids"] == ["restart"]


@pytest.mark.anyio
async def test_dispatch_reads_legacy_inherit_all_project_quick_buttons():
    async def handler(request):
        if request.url.path == "/api/workflow/w1":
            return httpx.Response(200, json={"id": "w1", "steps": {"inheritProjectQuickButtons": True}})
        return httpx.Response(200, json={"buttons": [{"id": "restart"}, {"id": "review"}]})

    result = await dispatch(build_parser().parse_args([
        "workflow", "quick-buttons", "--project", "p1", "--workflow", "w1",
    ]), WorkstepClient(transport=httpx.MockTransport(handler)))
    assert result["project_button_ids"] is None
    assert result["inherit_all_project_buttons"] is True
    assert [button["id"] for button in result["inherited_project_buttons"]] == ["restart", "review"]


@pytest.mark.anyio
async def test_project_action_create_uses_existing_daemon_quick_button_api(tmp_path):
    script = tmp_path / "restart.py"
    script.write_text("print('ready')\n")
    calls = []

    async def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/api/projects/p1/actions":
            return httpx.Response(405, json={"detail": "Method Not Allowed"})
        if request.url.path == "/api/project/list":
            return httpx.Response(200, json={"projects": [{"id": "p1", "path": str(tmp_path)}]})
        if request.method == "GET":
            return httpx.Response(200, json={"buttons": [{"id": "existing", "label": "保留", "prompt": "x"}]})
        body = json.loads(request.content)
        assert [button["id"] for button in body["buttons"]] == ["existing", "restart"]
        return httpx.Response(200, json={"buttons": body["buttons"]})

    result = await dispatch(build_parser().parse_args([
        "project", "action-create", "--project", "p1", "--action-id", "restart",
        "--title", "重启", "--script-file", str(script), "--cwd", "project",
    ]), WorkstepClient(transport=httpx.MockTransport(handler)))
    assert result["action_id"] == "restart"
    assert calls[-1] == ("PUT", "/api/chat-sessions/quick-buttons")
    assert (tmp_path / result["script_path"]).read_text() == script.read_text()


def test_parser_requires_subcommand():
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args([])
    with pytest.raises(SystemExit):
        parser.parse_args(["project"])


@pytest.mark.anyio
async def test_dispatch_maps_commands_to_tools():
    calls = []

    async def handler(request):
        calls.append((request.method, request.url.path, dict(request.url.params)))
        return httpx.Response(200, json={})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    parser = build_parser()

    await dispatch(parser.parse_args(["project", "list"]), client)
    assert calls[-1] == ("GET", "/api/project/list", {})

    await dispatch(
        parser.parse_args(["project", "init", "/tmp/x", "--name", "n"]),
        client,
    )
    assert calls[-1][:2] == ("POST", "/api/project/init")

    await dispatch(parser.parse_args(["task", "list", "--project", "p1"]), client)
    assert calls[-1] == ("GET", "/api/task/list", {"project_id": "p1"})

    await dispatch(
        parser.parse_args(["task", "get", "--project", "p1", "--task", "t1"]),
        client,
    )
    assert calls[-1][:2] == ("GET", "/api/task/t1")
    await dispatch(parser.parse_args(["task", "repos", "--project", "p1"]), client)
    assert calls[-1][:2] == ("GET", "/api/git/projects/p1/repositories")
    await dispatch(parser.parse_args(["task", "worktrees", "--project", "p1", "--task", "t1"]), client)
    assert calls[-1][:2] == ("GET", "/api/git/projects/p1/tasks/t1/workspace")

    await dispatch(parser.parse_args(["engine", "list"]), client)
    assert calls[-1] == ("GET", "/api/engine/list", {})

    await dispatch(parser.parse_args(["workflow", "list", "--project", "p1"]), client)
    assert calls[-1] == ("GET", "/api/workflow/list", {"project_id": "p1"})

    await dispatch(
        parser.parse_args([
            "workflow", "get", "--project", "p1", "--workflow", "w1",
        ]),
        client,
    )
    assert calls[-1] == ("GET", "/api/workflow/w1", {"project_id": "p1"})


@pytest.mark.anyio
async def test_dispatch_create_task_posts_title_with_confirm():
    captured = {}

    async def handler(request):
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": "t1", "title": "T"})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    result = await dispatch(
        build_parser().parse_args(
            [
                "task", "create", "--project", "p1", "--title", "T",
                "--cwd", "/w", "--workflow", "w1", "--start-step", "research",
            ]
        ),
        client,
    )
    assert result["id"] == "t1"
    assert captured["body"]["title"] == "T"
    assert captured["body"]["workflow_id"] == "w1"
    assert captured["body"]["start_step_key"] == "research"
    assert "confirm" not in captured["body"]


@pytest.mark.anyio
async def test_dispatch_create_task_defaults_cwd_to_project_path():
    async def handler(request):
        if request.url.path == "/api/project/list":
            return httpx.Response(200, json={"projects": [
                {"id": "p1", "path": "/tmp/project-a"}
            ]})
        body = json.loads(request.content)
        return httpx.Response(200, json={"id": "t1", "cwd": body["cwd"]})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    result = await dispatch(
        build_parser().parse_args(
            ["task", "create", "--project", "p1", "--title", "T"]
        ),
        client,
    )
    assert result["cwd"] == "/tmp/project-a"


def test_main_json_compact_output(capsys):
    async def handler(request):
        return httpx.Response(200, json={"projects": [{"id": "p1", "name": "P"}]})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    code = main(["project", "list", "--json"], client=client)
    out = capsys.readouterr().out.strip()
    assert code == 0
    assert json.loads(out) == {"projects": [{"id": "p1", "name": "P"}]}
    assert "\n" not in out


def test_main_pretty_json_by_default(capsys):
    async def handler(request):
        return httpx.Response(200, json={"projects": []})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    code = main(["project", "list"], client=client)
    out = capsys.readouterr().out
    assert code == 0
    assert json.loads(out) == {"projects": []}
    assert "\n" in out


def test_main_surfaces_errors_with_nonzero_exit(capsys):
    async def handler(request):
        return httpx.Response(500, json={"detail": "boom"})

    client = WorkstepClient(transport=httpx.MockTransport(handler))
    code = main(["project", "init", "/tmp/x"], client=client)
    out = json.loads(capsys.readouterr().out)
    assert code == 1
    assert out["ok"] is False
    assert "boom" in out["error"]
