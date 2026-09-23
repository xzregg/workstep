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

    args = parser.parse_args(["workflow", "list", "--project", "p1"])
    assert (args.command, args.subcommand) == ("workflow", "list")

    args = parser.parse_args([
        "workflow", "get", "--project", "p1", "--workflow", "w1",
    ])
    assert (args.command, args.subcommand) == ("workflow", "get")
    assert args.workflow_id == "w1"

    args = parser.parse_args(["engine", "list"])
    assert (args.command, args.subcommand) == ("engine", "list")


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
