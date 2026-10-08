"""WorkStep daemon command-line interface.

The CLI mirrors the internal tool registry (``services.tool_registry``) and
talks to the same local daemon REST endpoints through ``WorkstepClient``, so
manual and scripted usage always matches the agent-facing tools and the
frontend API contract.

Run from ``apps/daemon`` (the daemon must be running):

    uv run --no-sync python -m cli project list
    uv run --no-sync python -m cli task create --project <id> --title "任务标题"
    uv run --no-sync python -m cli --json engine list
"""

import argparse
import asyncio
import json
import os
from pathlib import Path

from services.quick_buttons import ACTION_ID, normalize_quick_buttons
from services.tool_registry import DEFAULT_DAEMON_URL, WorkstepClient


LIST_FIELDS = {
    "project": ("projects", ("id", "name", "path", "type", "connection_status")),
    "workflow": ("workflows", ("id", "name", "is_default", "deleted", "running", "failed", "nodeCount")),
    "task": ("tasks", ("id", "title", "status", "archived", "workflow_id", "created_at", "updated_at")),
    "engine": ("engines", ("id", "installed", "configured", "verified", "built_in", "version", "mode", "default_model")),
    "schedule": ("schedules", ("id", "name", "workflow_id", "status", "summary", "next_run_at", "last_run_at")),
    "channel": (None, ("id", "name", "platform", "enabled", "status")),
}


async def _create_project_action_on_existing_daemon(args, client, script_content: str) -> dict:
    """Use the project quick-button API when the daemon predates action-create."""
    if not ACTION_ID.fullmatch(args.action_id):
        raise ValueError("Action ID 无效")
    script_file = Path(args.script_file)
    if script_file.suffix not in {".sh", ".bash", ".py"}:
        raise ValueError("Action 脚本必须是 .sh、.bash 或 .py 文件")
    if not script_content.strip() or len(script_content.encode("utf-8")) > 128 * 1024:
        raise ValueError("Action 脚本为空或过大")
    projects = (await client.call("workstep_list_projects", {}))["projects"]
    project = next((item for item in projects if item["id"] == args.project_id), None)
    if project is None:
        raise ValueError("项目不存在")
    buttons = (await client.call("workstep_get_project_quick_buttons", {
        "project_id": args.project_id,
    }))["buttons"]
    button = normalize_quick_buttons([{
        "id": args.action_id, "kind": "action", "label": args.title,
        "action_id": args.action_id, "script_path": script_file.name,
        "cwd_mode": args.cwd_mode,
        "require_confirmation": not args.no_run_confirmation,
        "confirmation_input_prompt": args.input_prompt or "",
    }])[0]
    if any(item.get("id") == button["id"] or item.get("action_id") == args.action_id for item in buttons):
        raise FileExistsError("项目中已存在同名 Action")
    normalize_quick_buttons([*buttons, button])
    root = Path(project["path"]).resolve()
    from services.project_storage import data_directory
    action_root = data_directory(root) / "actions" / args.action_id
    await asyncio.to_thread(action_root.mkdir, parents=True, exist_ok=False)
    script = action_root / script_file.name
    metadata = action_root / "action.json"
    try:
        await asyncio.to_thread(script.write_text, script_content, encoding="utf-8")
        await asyncio.to_thread(metadata.write_text, json.dumps({
            "id": args.action_id,
            "interpreter": "python" if script.suffix == ".py" else "bash",
            "timeout_seconds": 0,
            "managed_service": True,
        }), encoding="utf-8")
        saved = await client.call("workstep_set_project_quick_buttons", {
            "project_id": args.project_id, "buttons": [*buttons, button], "confirm": "yes",
        })
        if saved.get("ok") is False:
            raise RuntimeError(saved["error"])
    except Exception:
        for child in (script, metadata):
            if child.exists():
                await asyncio.to_thread(child.unlink)
        await asyncio.to_thread(action_root.rmdir)
        raise
    return {"project_id": args.project_id, "action_id": args.action_id,
            "script_path": str(script.relative_to(root))}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="workstep",
        description="Manage WorkStep projects and tasks through the local daemon.",
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("WORKSTEP_DAEMON_URL", DEFAULT_DAEMON_URL),
        help="daemon base URL (default: %(default)s)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_json(sub: argparse.ArgumentParser, *, list_output: bool = False) -> None:
        sub.add_argument(
            "--json",
            action="store_true",
            help="compact single-line JSON output",
        )
        if list_output:
            sub.add_argument(
                "--verbose", action="store_true",
                help="include full data instead of list summaries",
            )

    project = subparsers.add_parser("project", help="manage projects")
    project_sub = project.add_subparsers(dest="subcommand", required=True)
    project_list = project_sub.add_parser("list", help="list registered project summaries")
    add_json(project_list, list_output=True)
    project_buttons = project_sub.add_parser("quick-buttons", help="list project chat quick buttons")
    project_buttons.add_argument("--project", required=True, dest="project_id", help="project id")
    add_json(project_buttons)
    project_init = project_sub.add_parser("init", help="initialize a new project")
    project_init.add_argument("path", help="absolute path of the project directory")
    project_init.add_argument("--name", help="project name (defaults to directory name)")
    add_json(project_init)
    project_action = project_sub.add_parser("action-create", help="create a project-wide Action shortcut")
    project_action.add_argument("--project", required=True, dest="project_id")
    project_action.add_argument("--action-id", required=True, dest="action_id")
    project_action.add_argument("--title", required=True)
    project_action.add_argument("--script-file", required=True, help="local .sh/.bash/.py file to publish")
    project_action.add_argument("--cwd", choices=("task", "project", "worktrees"), default="task", dest="cwd_mode")
    project_action.add_argument("--no-run-confirmation", action="store_true")
    project_action.add_argument("--input-prompt", help="require text in the confirmation dialog and pass it as WORKSTEP_ACTION_INPUT")
    add_json(project_action)

    task = subparsers.add_parser("task", help="manage tasks")
    task_sub = task.add_subparsers(dest="subcommand", required=True)
    task_list = task_sub.add_parser("list", help="list tasks of a project")
    task_list.add_argument("--project", required=True, dest="project_id", help="project id")
    add_json(task_list, list_output=True)
    task_get = task_sub.add_parser("get", help="get one task")
    task_get.add_argument("--project", required=True, dest="project_id", help="project id")
    task_get.add_argument("--task", required=True, dest="task_id", help="task id")
    add_json(task_get)
    task_create = task_sub.add_parser("create", help="create a task")
    task_create.add_argument("--project", required=True, dest="project_id", help="project id")
    task_create.add_argument("--title", required=True, help="task title")
    task_create.add_argument("--cwd", help="working directory (defaults to project path)")
    task_create.add_argument("--desc", dest="description", help="task description")
    task_create.add_argument("--workflow", dest="workflow_id", help="target workflow id")
    task_create.add_argument("--start-step", dest="start_step_key", help="workflow step key to start from")
    add_json(task_create)
    task_repos = task_sub.add_parser("repos", help="list project Git repositories")
    task_repos.add_argument("--project", required=True, dest="project_id")
    add_json(task_repos)
    task_worktrees = task_sub.add_parser("worktrees", help="list a task's Git worktrees")
    task_worktrees.add_argument("--project", required=True, dest="project_id")
    task_worktrees.add_argument("--task", required=True, dest="task_id")
    add_json(task_worktrees)
    task_worktree_add = task_sub.add_parser("worktree-add", help="create a Git worktree for a task")
    task_worktree_add.add_argument("--project", required=True, dest="project_id")
    task_worktree_add.add_argument("--task", required=True, dest="task_id")
    task_worktree_add.add_argument("--repository", required=True, dest="repository_id")
    task_worktree_add.add_argument("--alias", required=True)
    task_worktree_add.add_argument("--base", default="HEAD", dest="base_ref")
    task_worktree_add.add_argument("--branch", dest="branch_name", help="new branch name (defaults to workstep/<task>/<alias>)")
    add_json(task_worktree_add)

    workflow = subparsers.add_parser("workflow", help="inspect project workflows")
    workflow_sub = workflow.add_subparsers(dest="subcommand", required=True)
    workflow_list = workflow_sub.add_parser("list", help="list workflows of a project")
    workflow_list.add_argument("--project", required=True, dest="project_id", help="project id")
    add_json(workflow_list, list_output=True)
    workflow_get = workflow_sub.add_parser("get", help="get one workflow with its steps")
    workflow_get.add_argument("--project", required=True, dest="project_id", help="project id")
    workflow_get.add_argument("--workflow", required=True, dest="workflow_id", help="workflow id")
    add_json(workflow_get)
    workflow_buttons = workflow_sub.add_parser("quick-buttons", help="list workflow, stage and inherited project quick buttons")
    workflow_buttons.add_argument("--project", required=True, dest="project_id", help="project id")
    workflow_buttons.add_argument("--workflow", required=True, dest="workflow_id", help="workflow id")
    add_json(workflow_buttons)
    workflow_action = workflow_sub.add_parser("action-create", help="create a workflow Action shortcut")
    workflow_action.add_argument("--project", required=True, dest="project_id")
    workflow_action.add_argument("--workflow", required=True, dest="workflow_id")
    workflow_action.add_argument("--action-id", required=True, dest="action_id")
    workflow_action.add_argument("--title", required=True)
    workflow_action.add_argument("--script-file", required=True, help="local .sh/.bash/.py file to publish")
    workflow_action.add_argument("--cwd", choices=("task", "project", "worktrees"), default="task", dest="cwd_mode")
    workflow_action.add_argument("--no-run-confirmation", action="store_true", help="run button without a separate confirmation dialog")
    workflow_action.add_argument("--input-prompt", help="require text in the confirmation dialog and pass it as WORKSTEP_ACTION_INPUT")
    workflow_action.add_argument("--overwrite", action="store_true", help="replace the existing workflow Action with the same ID")
    add_json(workflow_action)

    channel = subparsers.add_parser("channel", help="send messages through channel bots")
    channel_sub = channel.add_subparsers(dest="subcommand", required=True)
    add_json(channel_sub.add_parser("list", help="list configured bots"), list_output=True)
    channel_sessions = channel_sub.add_parser("sessions", help="list active channel conversation recipients")
    channel_sessions.add_argument("--project", dest="project_id", required=True)
    add_json(channel_sessions)
    channel_bind = channel_sub.add_parser("bind", help="bind the current group session to a task")
    channel_bind.add_argument("--session", dest="session_id", required=True)
    channel_bind.add_argument("--project", dest="project_id", required=True)
    channel_bind.add_argument("--task", dest="task_id", required=True)
    add_json(channel_bind)
    channel_send = channel_sub.add_parser("send", help="send a notification without starting an LLM turn")
    channel_send.add_argument("--project", dest="project_id", required=True)
    channel_send.add_argument("--text", default="")
    channel_send.add_argument("--image", action="append", default=[], help="local image file (repeatable)")
    channel_send.add_argument("--file", action="append", default=[], help="local file attachment (repeatable)")
    channel_send.add_argument("--bot", dest="bot_id")
    recipients = channel_send.add_mutually_exclusive_group(required=True)
    recipients.add_argument("--session", dest="session_id")
    recipients.add_argument("--user", dest="user_id")
    recipients.add_argument("--group", dest="group_id")
    add_json(channel_send)

    engine = subparsers.add_parser("engine", help="manage engines")
    engine_sub = engine.add_subparsers(dest="subcommand", required=True)
    add_json(engine_sub.add_parser("list", help="list installed LLM engines"), list_output=True)

    schedule = subparsers.add_parser("schedule", help="manage project schedules")
    schedule_sub = schedule.add_subparsers(dest="subcommand", required=True)

    schedule_list = schedule_sub.add_parser("list", help="list schedules")
    schedule_list.add_argument("--project", required=True, dest="project_id")
    add_json(schedule_list, list_output=True)
    schedule_get = schedule_sub.add_parser("get", help="get one schedule")
    schedule_get.add_argument("--project", required=True, dest="project_id")
    schedule_get.add_argument("--schedule", required=True, dest="schedule_id")
    add_json(schedule_get)

    def add_schedule_fields(target, *, creating: bool) -> None:
        target.add_argument("--project", required=True, dest="project_id")
        if not creating:
            target.add_argument("--schedule", required=True, dest="schedule_id")
        target.add_argument("--workflow", dest="workflow_id")
        target.add_argument("--name", required=creating)
        target.add_argument("--title")
        target.add_argument("--desc", dest="description")
        target.add_argument("--timezone")
        target.add_argument("--start-step")
        target.add_argument("--review-overrides", help="JSON object")
        target.add_argument(
            "--mode", choices=("static", "agent"),
            default="static" if creating else None,
        )
        target.add_argument("--instruction", help="agent-mode 生成指令")
        target.add_argument(
            "--candidates",
            help="agent-mode 候选流程 id，逗号分隔；缺省表示项目全部流程",
        )
        target.add_argument("--retry-count", type=int)
        target.add_argument(
            "--execution", choices=("workflow", "immediate", "manual"),
            default="workflow" if creating else None,
        )
        target.add_argument(
            "--overlap", choices=("skip", "parallel", "queue"),
            default="skip" if creating else None,
        )
        rule = target.add_mutually_exclusive_group(required=creating)
        rule.add_argument("--at", help="one-time ISO date/time")
        rule.add_argument("--cron", help="five-field cron expression")
        add_json(target)

    add_schedule_fields(schedule_sub.add_parser("create", help="create schedule"), creating=True)
    add_schedule_fields(schedule_sub.add_parser("update", help="update schedule"), creating=False)
    for action in ("pause", "resume", "delete"):
        command = schedule_sub.add_parser(action, help=f"{action} schedule")
        command.add_argument("--project", required=True, dest="project_id")
        command.add_argument("--schedule", required=True, dest="schedule_id")
        add_json(command)
    schedule_runs = schedule_sub.add_parser("runs", help="list schedule runs")
    schedule_runs.add_argument("--project", required=True, dest="project_id")
    schedule_runs.add_argument("--schedule", required=True, dest="schedule_id")
    schedule_runs.add_argument("--limit", type=int, default=50)
    schedule_runs.add_argument("--offset", type=int, default=0)
    add_json(schedule_runs)

    return parser


async def dispatch(args: argparse.Namespace, client: WorkstepClient | None = None) -> dict | list:
    """Return list summaries by default, keeping detail and verbose responses intact."""
    result = await _dispatch(args, client)
    if args.subcommand != "list" or getattr(args, "verbose", False):
        return result
    key, fields = LIST_FIELDS[args.command]
    if isinstance(result, dict) and (result.get("ok") is False or key not in result):
        return result
    items = result[key] if key else result
    summaries = [{field: item[field] for field in fields if field in item} for item in items]
    return {**result, key: summaries} if key else summaries


async def _dispatch(args: argparse.Namespace, client: WorkstepClient | None = None) -> dict | list:
    """Resolve a parsed command to one tool call and return its JSON result."""
    client = client or WorkstepClient(base_url=args.url)
    command = args.command
    if command == "channel":
        if args.subcommand == "list":
            return await client.call("workstep_list_channel_bots", {})
        if args.subcommand == "sessions":
            return await client.call("workstep_list_channel_sessions", {"project_id": args.project_id})
        if args.subcommand == "bind":
            return await client.call("workstep_bind_channel_group", {
                "session_id": args.session_id, "project_id": args.project_id,
                "task_id": args.task_id, "confirm": "yes",
            })
        if (args.session_id and args.bot_id) or (not args.session_id and not args.bot_id):
            raise ValueError("按会话发送只需 --session；指定 --user 或 --group 时必须同时指定 --bot")
        arguments = {"project_id": args.project_id, "text": args.text, "confirm": "yes"}
        arguments.update({key: getattr(args, key) for key in ("session_id", "bot_id", "user_id", "group_id") if getattr(args, key)})
        if not args.text.strip() and not args.image and not args.file:
            raise ValueError("至少提供 --text、--image 或 --file")
        if len(args.image) + len(args.file) > 10:
            raise ValueError("单次最多发送 10 个附件")
        attachments = []
        for kind, paths in (("image", args.image), ("file", args.file)):
            for path in paths:
                import base64
                def read_attachment():
                    source = Path(path)
                    limit = (2 if kind == "image" else 20) * 1024 * 1024
                    with source.open("rb") as stream:
                        data = stream.read(limit + 1)
                    if not data or len(data) > limit:
                        raise ValueError("附件为空或超过渠道大小限制")
                    return source.name, base64.b64encode(data).decode("ascii")
                name, encoded = await asyncio.to_thread(read_attachment)
                uploaded = await client.call("workstep_upload_channel_attachment", {
                    "project_id": args.project_id, "filename": name,
                    "data_url": "data:application/octet-stream;base64," + encoded, "confirm": "yes",
                })
                if uploaded.get("ok") is False:
                    return uploaded
                if not uploaded.get("url"):
                    return {"ok": False, "error": "附件上传没有返回路径"}
                attachments.append({"kind": kind, "path": uploaded["url"]})
        if attachments:
            arguments["attachments"] = attachments
        return await client.call("workstep_send_channel_message", arguments)
    if command == "project":
        if args.subcommand == "list":
            return await client.call("workstep_list_projects", {})
        if args.subcommand == "quick-buttons":
            return await client.call("workstep_get_project_quick_buttons", {"project_id": args.project_id})
        if args.subcommand == "init":
            return await client.call(
                "workstep_create_project",
                {"path": args.path, "name": args.name, "confirm": "yes"},
            )
        if args.subcommand == "action-create":
            script_file = Path(args.script_file)
            script_content = await asyncio.to_thread(script_file.read_text, encoding="utf-8")
            result = await client.call("workstep_create_project_action", {
                "project_id": args.project_id,
                "action_id": args.action_id,
                "title": args.title,
                "script_path": script_file.name,
                "script_content": script_content,
                "cwd_mode": args.cwd_mode,
                "require_confirmation": not args.no_run_confirmation,
                "confirmation_input_prompt": args.input_prompt or "",
                "confirm": "yes",
            })
            if result.get("ok") is False and result.get("error") in {"Not Found", "Method Not Allowed"}:
                return await _create_project_action_on_existing_daemon(args, client, script_content)
            return result
    if command == "task":
        if args.subcommand == "list":
            return await client.call(
                "workstep_list_tasks", {"project_id": args.project_id}
            )
        if args.subcommand == "get":
            return await client.call(
                "workstep_get_task",
                {"project_id": args.project_id, "task_id": args.task_id},
            )
        if args.subcommand == "repos":
            return await client.call("workstep_list_git_repositories", {"project_id": args.project_id})
        if args.subcommand == "worktrees":
            return await client.call("workstep_get_task_workspace", {"project_id": args.project_id, "task_id": args.task_id})
        if args.subcommand == "worktree-add":
            return await client.call("workstep_add_task_worktree", {
                "project_id": args.project_id,
                "task_id": args.task_id,
                "repository_id": args.repository_id,
                "alias": args.alias,
                "base_ref": args.base_ref,
                "branch_name": args.branch_name,
                "confirm": "yes",
            })
        if args.subcommand == "create":
            arguments: dict = {
                "project_id": args.project_id,
                "title": args.title,
                "confirm": "yes",
            }
            if args.cwd:
                arguments["cwd"] = args.cwd
            if args.description:
                arguments["description"] = args.description
            if args.workflow_id:
                arguments["workflow_id"] = args.workflow_id
            if args.start_step_key:
                arguments["start_step_key"] = args.start_step_key
            return await client.call("workstep_create_task", arguments)
    if command == "workflow":
        arguments = {"project_id": args.project_id}
        if args.subcommand == "list":
            return await client.call("workstep_list_workflows", arguments)
        if args.subcommand == "get":
            return await client.call(
                "workstep_get_workflow",
                {**arguments, "workflow_id": args.workflow_id},
            )
        if args.subcommand == "quick-buttons":
            workflow = await client.call("workstep_get_workflow", {**arguments, "workflow_id": args.workflow_id})
            if workflow.get("ok") is False:
                return workflow
            project_buttons = await client.call("workstep_get_project_quick_buttons", arguments)
            if project_buttons.get("ok") is False:
                return project_buttons
            steps = workflow.get("steps") or {}
            selected_ids = steps.get("projectQuickButtonIds")
            inherit_all = not isinstance(selected_ids, list) and steps.get("inheritProjectQuickButtons") is True
            inherited = [
                button for button in project_buttons["buttons"]
                if inherit_all or (isinstance(selected_ids, list) and button.get("id") in selected_ids)
            ]
            return {
                "project_id": args.project_id,
                "workflow_id": args.workflow_id,
                "workflow_buttons": steps.get("quickButtons", []),
                "stage_buttons": [
                    {"step_key": node.get("key", node.get("type", node.get("id"))),
                     "label": node.get("title"), "buttons": node["quickButtons"]}
                    for node in steps.get("nodes", steps.get("steps", []))
                    if isinstance(node, dict) and node.get("quickButtons")
                ],
                "project_button_ids": selected_ids if isinstance(selected_ids, list) else None,
                "inherit_all_project_buttons": inherit_all,
                "inherited_project_buttons": inherited,
            }
        if args.subcommand == "action-create":
            script_file = Path(args.script_file)
            script_content = await asyncio.to_thread(script_file.read_text, encoding="utf-8")
            return await client.call("workstep_create_workflow_action", {
                **arguments,
                "workflow_id": args.workflow_id,
                "action_id": args.action_id,
                "title": args.title,
                "script_path": script_file.name,
                "script_content": script_content,
                "cwd_mode": args.cwd_mode,
                "require_confirmation": not args.no_run_confirmation,
                "confirmation_input_prompt": args.input_prompt or "",
                "overwrite": args.overwrite,
                "confirm": "yes",
            })
    if command == "engine" and args.subcommand == "list":
        return await client.call("workstep_list_engines", {})
    if command == "schedule":
        base = {"project_id": args.project_id}
        if args.subcommand == "list":
            return await client.call("workstep_list_schedules", base)
        if args.subcommand == "get":
            return await client.call(
                "workstep_get_schedule", {**base, "schedule_id": args.schedule_id}
            )
        if args.subcommand in {"pause", "resume", "delete"}:
            return await client.call(
                f"workstep_{args.subcommand}_schedule",
                {**base, "schedule_id": args.schedule_id, "confirm": "yes"},
            )
        if args.subcommand == "runs":
            return await client.call("workstep_list_schedule_runs", {
                **base, "schedule_id": args.schedule_id,
                "limit": args.limit, "offset": args.offset,
            })
        if args.subcommand in {"create", "update"}:
            arguments = dict(base)
            existing = None
            if args.subcommand == "update":
                arguments["schedule_id"] = args.schedule_id
            mode = getattr(args, "mode", "static") or "static"
            if args.subcommand == "create" and mode != "agent" and not args.workflow_id:
                raise ValueError(
                    "--workflow is required when --mode is static (default)"
                )
            for source, target in (
                ("workflow_id", "workflow_id"), ("name", "name"),
                ("execution", "execution_mode"), ("overlap", "overlap_policy"),
            ):
                value = getattr(args, source, None)
                if value is not None:
                    arguments[target] = value
            if mode == "agent" and args.workflow_id is None:
                arguments["workflow_id"] = ""
            if args.at or args.cron:
                arguments["rule"] = {
                    "kind": "once" if args.at else "cron",
                    "run_at" if args.at else "expression": args.at or args.cron,
                    "timezone": args.timezone or str(__import__("datetime").datetime.now().astimezone().tzinfo),
                }
            elif args.subcommand == "update" and args.timezone:
                existing = await client.call("workstep_get_schedule", {
                    **base, "schedule_id": args.schedule_id,
                })
                arguments["rule"] = {
                    **existing.get("rule", {}), "timezone": args.timezone,
                }
            template = {}
            if args.title is not None:
                template["title"] = args.title
            if args.description is not None:
                template["description"] = args.description
            if args.start_step is not None:
                template["start_step_key"] = args.start_step
            if args.review_overrides is not None:
                template["review_overrides"] = json.loads(args.review_overrides)
            if mode != "static":
                template["mode"] = mode
            if args.instruction is not None:
                template["instruction"] = args.instruction
            if args.candidates is not None:
                template["candidate_workflow_ids"] = [
                    item.strip()
                    for item in args.candidates.split(",")
                    if item.strip()
                ]
            if args.retry_count is not None:
                template["retry_count"] = args.retry_count
            if template:
                if args.subcommand == "update":
                    existing = existing or await client.call("workstep_get_schedule", {
                        **base, "schedule_id": args.schedule_id,
                    })
                    template = {**existing.get("task_template", {}), **template}
                arguments["task_template"] = template
            arguments["confirm"] = "yes"
            return await client.call(
                f"workstep_{args.subcommand}_schedule", arguments
            )
    return {
        "ok": False,
        "error": f"未知命令：{command} {getattr(args, 'subcommand', '')}",
    }


def main(argv: list[str] | None = None, client: WorkstepClient | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = asyncio.run(dispatch(args, client))
    except Exception as exc:  # unexpected failures still exit non-zero
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    indent = None if getattr(args, "json", False) else 2
    print(json.dumps(result, ensure_ascii=False, indent=indent))
    if isinstance(result, dict) and result.get("ok") is False:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
