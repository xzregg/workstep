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

from services.tool_registry import DEFAULT_DAEMON_URL, WorkstepClient


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

    def add_json(sub: argparse.ArgumentParser) -> None:
        sub.add_argument(
            "--json",
            action="store_true",
            help="compact single-line JSON output",
        )

    project = subparsers.add_parser("project", help="manage projects")
    project_sub = project.add_subparsers(dest="subcommand", required=True)
    add_json(project_sub.add_parser("list", help="list registered projects"))
    project_init = project_sub.add_parser("init", help="initialize a new project")
    project_init.add_argument("path", help="absolute path of the project directory")
    project_init.add_argument("--name", help="project name (defaults to directory name)")
    add_json(project_init)

    task = subparsers.add_parser("task", help="manage tasks")
    task_sub = task.add_subparsers(dest="subcommand", required=True)
    task_list = task_sub.add_parser("list", help="list tasks of a project")
    task_list.add_argument("--project", required=True, dest="project_id", help="project id")
    add_json(task_list)
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
    add_json(workflow_list)
    workflow_get = workflow_sub.add_parser("get", help="get one workflow with its steps")
    workflow_get.add_argument("--project", required=True, dest="project_id", help="project id")
    workflow_get.add_argument("--workflow", required=True, dest="workflow_id", help="workflow id")
    add_json(workflow_get)

    engine = subparsers.add_parser("engine", help="manage engines")
    engine_sub = engine.add_subparsers(dest="subcommand", required=True)
    add_json(engine_sub.add_parser("list", help="list installed LLM engines"))

    schedule = subparsers.add_parser("schedule", help="manage project schedules")
    schedule_sub = schedule.add_subparsers(dest="subcommand", required=True)

    schedule_list = schedule_sub.add_parser("list", help="list schedules")
    schedule_list.add_argument("--project", required=True, dest="project_id")
    add_json(schedule_list)
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


async def dispatch(args: argparse.Namespace, client: WorkstepClient | None = None) -> dict:
    """Resolve a parsed command to one tool call and return its JSON result."""
    client = client or WorkstepClient(base_url=args.url)
    command = args.command
    if command == "project":
        if args.subcommand == "list":
            return await client.call("workstep_list_projects", {})
        if args.subcommand == "init":
            return await client.call(
                "workstep_create_project",
                {"path": args.path, "name": args.name, "confirm": "yes"},
            )
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
