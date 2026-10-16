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
import re
from pathlib import Path

from services.quick_buttons import ACTION_ID, normalize_quick_buttons
from services.tool_registry import DEFAULT_DAEMON_URL, WorkstepClient


LIST_FIELDS = {
    "project": ("projects", ("id", "name", "path", "type", "connection_status")),
    "workflow": ("workflows", ("id", "name", "is_default", "deleted", "running", "failed", "nodeCount")),
    "task": ("tasks", ("id", "title", "status", "archived", "workflow_id", "created_at", "updated_at")),
    "engine": ("engines", ("id", "enabled", "custom", "installed", "configured", "verified", "built_in", "version", "mode", "default_model")),
    "schedule": ("schedules", ("id", "name", "target_type", "target_task_id", "workflow_id", "status", "summary", "next_run_at", "last_run_at")),
    "skin": (None, ("manifest", "revision")),
    "language": (None, ("manifest", "revision")),
    "skill": (None, ("project_id", "session_id", "package_path")),
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


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def _nonnegative_int(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be nonnegative")
    return number


def _output_fields(value: str) -> tuple[str, ...]:
    fields = tuple(field.strip() for field in value.split(","))
    if any(not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", field) for field in fields):
        raise argparse.ArgumentTypeError("use comma-separated top-level field names")
    return tuple(dict.fromkeys(fields))


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
        if list_output or sub.prog.endswith(" get"):
            sub.add_argument("--fields", type=_output_fields,
                             help="select comma-separated top-level resource fields; absent fields are omitted")
        if list_output:
            sub.add_argument("--limit", type=_positive_int, help="maximum output items (local slicing)")
            sub.add_argument("--offset", type=_nonnegative_int, help="skip output items (local slicing)")
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
    task_list.add_argument("--archived", action="store_true", help="list archived tasks only")
    task_list.add_argument("--status", help="filter by exact task status")
    task_list.add_argument("--workflow", dest="workflow_id", help="filter by workflow id")
    add_json(task_list, list_output=True)
    task_get = task_sub.add_parser("get", help="get one task")
    task_get.add_argument("--project", required=True, dest="project_id", help="project id")
    task_get.add_argument("--task", required=True, dest="task_id", help="task id")
    add_json(task_get)
    for action, help_text in (
        ("step-message", "inject a message into a running step"),
        ("step-stop", "request cancellation of one step"),
        ("step-start", "start a step and downstream with a message (stops the old task runner)"),
    ):
        step_control = task_sub.add_parser(action, help=help_text)
        step_control.add_argument("--project", required=True, dest="project_id")
        step_control.add_argument("--task", required=True, dest="task_id")
        step_control.add_argument("--step", required=True, dest="step_key")
        if action != "step-stop":
            step_control.add_argument("--content", required=True, help="step message")
        if action == "step-message":
            step_control.add_argument("--as-guidance", action="store_true", help="also retain for later attempts")
        if action == "step-start":
            step_control.add_argument("--reset-session", action="store_true", help="start a fresh engine session")
        add_json(step_control)
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

    skill = subparsers.add_parser('skill', help='create skill drafts in the shared runtime workspace')
    skill_sub = skill.add_subparsers(dest='subcommand', required=True)
    add_json(skill_sub.add_parser('create'))

    skin = subparsers.add_parser("skin", help="create and manage declarative WorkStep skins")
    skin_sub = skin.add_subparsers(dest="subcommand", required=True)
    for action in ("list", "contract"):
        add_json(skin_sub.add_parser(action), list_output=action == "list")
    for action in ("validate", "register"):
        command = skin_sub.add_parser(action)
        command.add_argument("path")
        if action == "register": command.add_argument("--replace", action="store_true")
        add_json(command)
    for action in ("delete", "export"):
        command = skin_sub.add_parser(action)
        command.add_argument("skin_id")
        if action == "export": command.add_argument("--output", required=True)
        add_json(command)

    language = subparsers.add_parser("language", help="create and manage Runtime WorkStep language packs")
    language_sub = language.add_subparsers(dest="subcommand", required=True)
    for action in ("list", "contract"):
        add_json(language_sub.add_parser(action), list_output=action == "list")
    for action in ("validate", "register"):
        command = language_sub.add_parser(action)
        command.add_argument("path")
        if action == "register": command.add_argument("--replace", action="store_true")
        add_json(command)
    for action in ("delete", "export"):
        command = language_sub.add_parser(action)
        command.add_argument("pack_id")
        if action == "export": command.add_argument("--output", required=True)
        add_json(command)

    engine = subparsers.add_parser("engine", help="manage engines")
    engine_sub = engine.add_subparsers(dest="subcommand", required=True)
    add_json(engine_sub.add_parser("list", help="list installed LLM engines"), list_output=True)

    for action in ("inspect", "install", "validate", "register", "configure"):
        command = engine_sub.add_parser(action, help=f"{action} a custom engine Python file or package directory")
        command.add_argument("path")
        if action in {"install", "validate"}:
            command.add_argument("--no-wait", action="store_true", help="return operation ID immediately")
        if action == "register":
            command.add_argument("--replace", action="store_true")
        if action == "configure":
            command.add_argument("--config-file", required=True, help="JSON with values, clear, confirmed, provider_id and model")
        add_json(command)
    for action in ("disable", "enable", "rollback", "export"):
        command = engine_sub.add_parser(action)
        command.add_argument("engine_id")
        if action == "export":
            command.add_argument("--output", required=True)
        add_json(command)
    for action in ("operation", "stop"):
        command = engine_sub.add_parser(action)
        command.add_argument("operation_id")
        add_json(command)

    schedule = subparsers.add_parser("schedule", help="manage project schedules")
    schedule_sub = schedule.add_subparsers(dest="subcommand", required=True)

    schedule_list = schedule_sub.add_parser("list", help="list schedules")
    schedule_list.add_argument("--project", required=True, dest="project_id")
    schedule_list.add_argument("--target", choices=("project", "task"), dest="target_type")
    schedule_list.add_argument("--task", dest="target_task_id")
    add_json(schedule_list, list_output=True)
    schedule_get = schedule_sub.add_parser("get", help="get one schedule")
    schedule_get.add_argument("--project", required=True, dest="project_id")
    schedule_get.add_argument("--schedule", required=True, dest="schedule_id")
    add_json(schedule_get)

    notification_options = schedule_sub.add_parser("notification-options", help="list project notification destinations and task defaults")
    notification_options.add_argument("--project", required=True, dest="project_id")
    notification_options.add_argument("--task", dest="target_task_id")
    add_json(notification_options)
    retry_notification = schedule_sub.add_parser("retry-notification", help="retry only a failed occurrence notification")
    retry_notification.add_argument("--project", required=True, dest="project_id")
    retry_notification.add_argument("--schedule", required=True, dest="schedule_id")
    retry_notification.add_argument("--run", required=True, dest="run_id")
    add_json(retry_notification)

    def add_schedule_fields(target, *, creating: bool) -> None:
        target.add_argument("--project", required=True, dest="project_id")
        if not creating:
            target.add_argument("--schedule", required=True, dest="schedule_id")
        target.add_argument("--target", choices=("project", "task"), dest="target_type")
        target.add_argument("--task", dest="target_task_id")
        target.add_argument("--notify", action=argparse.BooleanOptionalAction, default=None, help="notify channel when this occurrence finishes")
        target.add_argument("--notify-session", help="project channel session id")
        target.add_argument("--notify-bot", help="bot id for a task-bound group")
        target.add_argument("--notify-group", help="task-bound platform group id")
        target.add_argument("--stop-condition", choices=("manual", "task-terminal"))
        target.add_argument("--workflow", dest="workflow_id")
        target.add_argument("--name", required=creating)
        target.add_argument("--title")
        target.add_argument("--desc", dest="description")
        target.add_argument("--timezone", help="IANA timezone (default: UTC)")
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
        rule.add_argument("--every-minutes", type=int)
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
    """Filter, slice and project CLI output without changing the daemon contract."""
    result = await _dispatch(args, client)
    if isinstance(result, dict) and result.get("ok") is False:
        return result
    fields = getattr(args, "fields", None)
    if args.subcommand != "list":
        if fields and isinstance(result, dict):
            return {field: result[field] for field in fields if field in result}
        return result
    key, summary_fields = LIST_FIELDS[args.command]
    if key and (not isinstance(result, dict) or key not in result):
        return result
    items = result[key] if key else result
    if not isinstance(items, list):
        return result
    filtered = False
    if args.command == "task":
        for option, field in (("status", "status"), ("workflow_id", "workflow_id")):
            value = getattr(args, option, None)
            if value is not None:
                items = [item for item in items if item.get(field) == value]
                filtered = True
    limit, offset = getattr(args, "limit", None), getattr(args, "offset", None)
    paginated = limit is not None or offset is not None
    total = len(items)
    start = offset or 0
    if paginated:
        items = items[start: start + limit if limit is not None else None]
    if fields is None and not getattr(args, "verbose", False):
        fields = summary_fields
    if fields is not None:
        items = [{field: item[field] for field in fields if field in item} for item in items]
    output = {**result, key: items} if key else items
    if paginated:
        if key is None:
            output = {"items": items}
        output.update(total=total, offset=start, remaining=max(0, total - start - len(items)))
    elif filtered and isinstance(output, dict) and "total" in output:
        output["total"] = total
    return output


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
        step_operations = {
            "step-message": "workstep_send_step_message",
            "step-stop": "workstep_stop_step",
            "step-start": "workstep_start_step",
        }
        if args.subcommand in step_operations:
            arguments = {
                "project_id": args.project_id, "task_id": args.task_id,
                "step_key": args.step_key, "confirm": "yes",
            }
            if args.subcommand != "step-stop":
                arguments["content"] = args.content
            if args.subcommand == "step-message":
                arguments["as_guidance"] = args.as_guidance
            if args.subcommand == "step-start":
                arguments["reset_session"] = args.reset_session
            return await client.call(step_operations[args.subcommand], arguments)
        if args.subcommand == "list":
            arguments = {"project_id": args.project_id}
            if args.archived:
                arguments["archived"] = True
            return await client.call(
                "workstep_list_tasks", arguments
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
    if command == 'skill':
        return await client.call('workstep_create_skill_draft', {'confirm': 'yes'})
    if command == "skin":
        action = args.subcommand
        arguments = {"confirm": "yes"}
        if hasattr(args, "path"):
            arguments["path"] = str(await asyncio.to_thread(Path(args.path).expanduser().resolve))
        if hasattr(args, "skin_id"): arguments["skin_id"] = args.skin_id
        if action == "register": arguments["replace"] = args.replace
        if action == "export": arguments["output"] = str(await asyncio.to_thread(Path(args.output).expanduser().resolve))
        return await client.call("workstep_skin_" + action, arguments)
    if command == "language":
        action = args.subcommand
        arguments = {"confirm": "yes"}
        if hasattr(args, "path"):
            arguments["path"] = str(await asyncio.to_thread(Path(args.path).expanduser().resolve))
        if hasattr(args, "pack_id"): arguments["pack_id"] = args.pack_id
        if action == "register": arguments["replace"] = args.replace
        if action == "export": arguments["output"] = str(await asyncio.to_thread(Path(args.output).expanduser().resolve))
        return await client.call("workstep_language_" + action, arguments)
    if command == "engine":
        action = args.subcommand
        if action == "list":
            return await client.call("workstep_list_engines", {})
        arguments = {"confirm": "yes"}
        if hasattr(args, "path"):
            arguments["path"] = str(await asyncio.to_thread(Path(args.path).expanduser().resolve))
        if action == "inspect":
            return await client.call("workstep_custom_engine_inspect", arguments)
        if action == "configure":
            data = await asyncio.to_thread(Path(args.config_file).read_text, encoding="utf-8")
            payload = json.loads(data)
            if not isinstance(payload, dict) or set(payload) - {"values", "clear", "confirmed", "provider_id", "model"}:
                raise ValueError("配置文件字段无效")
            return await client.call("workstep_custom_engine_configure", {**arguments, **payload})
        if action == "register":
            return await client.call("workstep_custom_engine_register", {**arguments, "replace": args.replace})
        if action in {"install", "validate"}:
            operation = await client.call("workstep_custom_engine_operation", {**arguments, "action": action})
            if operation.get("ok") is False or args.no_wait:
                return operation
            operation_id = operation["id"]
            try:
                while operation.get("status") == "running":
                    operation = await client.call("workstep_custom_engine_operation_get", {"operation_id": operation_id})
                    if operation.get("ok") is False:
                        return operation
                    if operation.get("status") == "running":
                        await asyncio.sleep(.5)
            except asyncio.CancelledError:
                await client.call("workstep_custom_engine_operation_stop", {"operation_id": operation_id, "confirm": "yes"})
                raise
            return operation.get("result") or {"ok": False, "operation": operation}
        if action in {"operation", "stop"}:
            return await client.call("workstep_custom_engine_operation_get" if action == "operation" else "workstep_custom_engine_operation_stop", {**arguments, "operation_id": args.operation_id})
        if action in {"disable", "enable"}:
            return await client.call("workstep_custom_engine_disable", {**arguments, "engine_id": args.engine_id, "disabled": action == "disable"})
        if action == "rollback":
            return await client.call("workstep_custom_engine_rollback", {**arguments, "engine_id": args.engine_id})
        if action == "export":
            return await client.call("workstep_custom_engine_export", {**arguments, "engine_id": args.engine_id, "output": str(Path(args.output).expanduser().resolve())})
    if command == "schedule":
        base = {"project_id": args.project_id}
        if args.subcommand == "list":
            return await client.call("workstep_list_schedules", {**base, **({"target_type":args.target_type} if args.target_type else {}), **({"task_id":args.target_task_id} if args.target_task_id else {})})
        if args.subcommand == "get":
            return await client.call(
                "workstep_get_schedule", {**base, "schedule_id": args.schedule_id}
            )
        if args.subcommand in {"pause", "resume", "delete"}:
            return await client.call(
                f"workstep_{args.subcommand}_schedule",
                {**base, "schedule_id": args.schedule_id, "confirm": "yes"},
            )
        if args.subcommand == "notification-options":
            return await client.call("workstep_schedule_notification_options", {**base, **({"task_id":args.target_task_id} if args.target_task_id else {})})
        if args.subcommand == "retry-notification":
            return await client.call("workstep_retry_schedule_notification", {**base, "schedule_id":args.schedule_id, "run_id":args.run_id, "confirm":"yes"})
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
            target_type = args.target_type
            if args.subcommand == "update" and not target_type:
                existing = await client.call("workstep_get_schedule", {**base, "schedule_id": args.schedule_id})
                target_type = existing.get("target_type", "project")
            target_type = target_type or "project"
            destination = None
            if args.notify_session and (args.notify_bot or args.notify_group):
                raise ValueError("--notify-session cannot be combined with --notify-bot/--notify-group")
            if bool(args.notify_bot) != bool(args.notify_group):
                raise ValueError("--notify-bot and --notify-group must be supplied together")
            if args.notify_session:
                destination = {"session_id": args.notify_session}
            elif args.notify_bot:
                destination = {"bot_id": args.notify_bot, "group_id": args.notify_group}
            if args.notify is False and destination:
                raise ValueError("--no-notify cannot include a notification destination")
            if args.notify is not None or destination:
                arguments["notification"] = {"enabled": args.notify is not False}
                if destination:
                    arguments["notification"]["target"] = destination
                elif args.notify and existing and existing.get("notification", {}).get("target"):
                    arguments["notification"]["target"] = existing["notification"]["target"]
            if args.target_type is not None:
                arguments["target_type"] = args.target_type
            if target_type == "project" and (args.target_task_id or args.stop_condition):
                raise ValueError("--task and --stop-condition require --target task")
            if target_type == "task":
                arguments["target_type"] = target_type
                if args.target_task_id is not None:
                    arguments["target_task_id"] = args.target_task_id
                if args.instruction is not None:
                    arguments["instruction"] = args.instruction
                if args.stop_condition is not None:
                    arguments["stop_condition"] = args.stop_condition.replace("-", "_")
            mode = getattr(args, "mode", "static") or "static"
            if args.subcommand == "create" and target_type != "task" and mode != "agent" and not args.workflow_id:
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
            if args.every_minutes is not None:
                arguments["rule"] = {"kind":"minutes", "every": args.every_minutes, "timezone":args.timezone or "UTC"}
            elif args.at or args.cron:
                arguments["rule"] = {
                    "kind": "once" if args.at else "cron",
                    "run_at" if args.at else "expression": args.at or args.cron,
                    "timezone": args.timezone or "UTC",
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
            if target_type == "task":
                if args.subcommand == "create" and (not args.target_task_id or not args.instruction):
                    raise ValueError("--task and --instruction are required for task schedules")
                if args.workflow_id or args.title or args.description or args.start_step or args.review_overrides or args.candidates or args.retry_count is not None or mode != "static":
                    raise ValueError("Task schedules cannot contain project task creation options")
                template = {}
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
    print(json.dumps(result, ensure_ascii=False, indent=indent,
                     separators=(",", ":") if getattr(args, "json", False) else None))
    if isinstance(result, dict) and result.get("ok") is False:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
