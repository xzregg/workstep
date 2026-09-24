"""WorkStep internal tool registry.

Exposes daemon REST endpoints as structured tools that Agent helpers can load
on demand (CLI and engine-injected tools share ``WorkstepClient``). The client
talks HTTP to the local daemon, so tool behavior always matches the frontend's
API contract.
"""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

DEFAULT_DAEMON_URL = "http://127.0.0.1:8765"


@dataclass(frozen=True)
class WorkstepTool:
    """One WorkStep operation exposed to agents as a tool."""

    name: str
    description: str
    method: str
    path: str
    parameters: dict[str, dict] = field(default_factory=dict)
    required: tuple[str, ...] = ()
    read_only: bool = True
    side_effect: str = ""
    path_params: tuple[str, ...] = ()
    query_params: tuple[str, ...] = ()
    body_params: tuple[str, ...] = ()

    def example(self) -> str:
        """A JSON example of calling this tool."""
        sample = {key: "..." for key in self.required}
        if not self.read_only:
            sample["confirm"] = "yes"
        return json.dumps(sample, ensure_ascii=False)


WORKSTEP_TOOLS: list[WorkstepTool] = [
    WorkstepTool(
        name="workstep_list_projects",
        description=(
            "List all registered WorkStep projects with id, name, path and "
            "workflow steps."
        ),
        method="GET",
        path="/api/project/list",
        read_only=True,
    ),
    WorkstepTool(
        name="workstep_get_project",
        description=(
            "Get one registered project by id; returns id, name, path and steps."
        ),
        method="GET",
        path="/api/project/list",
        parameters={"project_id": {"type": "string", "description": "project id"}},
        required=("project_id",),
        read_only=True,
    ),
    WorkstepTool(
        name="workstep_list_workflows",
        description=(
            "List workflows of a project, including ids, names, status and "
            "step counts."
        ),
        method="GET",
        path="/api/workflow/list",
        parameters={"project_id": {"type": "string", "description": "project id"}},
        required=("project_id",),
        read_only=True,
        query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_get_workflow",
        description="Get one workflow with its complete step definition.",
        method="GET",
        path="/api/workflow/{workflow_id}",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "workflow_id": {"type": "string", "description": "workflow id"},
        },
        required=("project_id", "workflow_id"),
        read_only=True,
        path_params=("workflow_id",),
        query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_list_tasks",
        description=(
            "List tasks of a project (optionally archived), including status, "
            "step progress and workflow info."
        ),
        method="GET",
        path="/api/task/list",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "archived": {"type": "boolean", "description": "show archived tasks only; default false"},
        },
        required=("project_id",),
        read_only=True,
        query_params=("project_id", "archived"),
    ),
    WorkstepTool(
        name="workstep_get_task",
        description="Get one task by id within a project.",
        method="GET",
        path="/api/task/{task_id}",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "task_id": {"type": "string", "description": "task id"},
        },
        required=("project_id", "task_id"),
        read_only=True,
        path_params=("task_id",),
        query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_list_git_repositories",
        description="List Git repositories discovered in one project before choosing task worktrees.",
        method="GET",
        path="/api/git/projects/{project_id}/repositories",
        parameters={"project_id": {"type": "string", "description": "project id"}},
        required=("project_id",),
        path_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_get_task_workspace",
        description="List only the Git worktrees attached to one task.",
        method="GET",
        path="/api/git/projects/{project_id}/tasks/{task_id}/workspace",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "task_id": {"type": "string", "description": "task id"},
        },
        required=("project_id", "task_id"),
        path_params=("project_id", "task_id"),
    ),
    WorkstepTool(
        name="workstep_add_task_worktree",
        description="Create a task-specific Git worktree only for a repository needed by the task.",
        method="POST",
        path="/api/git/projects/{project_id}/tasks/{task_id}/worktrees",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "task_id": {"type": "string", "description": "task id"},
            "repository_id": {"type": "string", "description": "id from workstep_list_git_repositories"},
            "alias": {"type": "string", "description": "directory name within the task workspace"},
            "base_ref": {"type": "string", "description": "base branch or commit; defaults to HEAD"},
            "branch_name": {"type": "string", "description": "new branch name; defaults to workstep/<task_id>/<alias>"},
        },
        required=("project_id", "task_id", "repository_id", "alias"),
        read_only=False,
        side_effect="create a Git branch and worktree for this task",
        path_params=("project_id", "task_id"),
        body_params=("repository_id", "alias", "base_ref", "branch_name"),
    ),
    WorkstepTool(
        name="workstep_list_engines",
        description=(
            "List installed LLM engines and their capabilities (coordinator, "
            "resume, vision support)."
        ),
        method="GET",
        path="/api/engine/list",
        read_only=True,
    ),
    WorkstepTool(
        name="workstep_create_project",
        description=(
            "Create and register a new WorkStep project at an absolute path."
        ),
        method="POST",
        path="/api/project/init",
        parameters={
            "path": {"type": "string", "description": "absolute project directory path"},
            "name": {"type": "string", "description": "project name; defaults to the directory name"},
        },
        required=("path",),
        read_only=False,
        side_effect="initialize a project directory and register it in WorkStep",
        body_params=("path", "name"),
    ),
    WorkstepTool(
        name="workstep_create_task",
        description=(
            "Create a task in a project. cwd defaults to the project path when "
            "omitted."
        ),
        method="POST",
        path="/api/task/create",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "title": {"type": "string", "description": "task title"},
            "cwd": {"type": "string", "description": "working directory; defaults to the project path"},
            "description": {"type": "string", "description": "task description (optional)"},
            "workflow_id": {"type": "string", "description": "target workflow id (optional; defaults to the project default workflow)"},
            "start_step_key": {"type": "string", "description": "workflow step key to start from (optional)"},
        },
        required=("project_id", "title"),
        read_only=False,
        side_effect="create a task in the project",
        query_params=("project_id",),
        body_params=("title", "cwd", "description", "workflow_id", "start_step_key"),
    ),
    WorkstepTool(
        name="workstep_list_schedules",
        description="List project schedules with status and next run time.",
        method="GET", path="/api/schedule/list",
        parameters={"project_id": {"type": "string", "description": "project id"}},
        required=("project_id",), query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_get_schedule",
        description="Get one project schedule and its normalized rule.",
        method="GET", path="/api/schedule/{schedule_id}",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "schedule_id": {"type": "string", "description": "schedule id"},
        },
        required=("project_id", "schedule_id"), path_params=("schedule_id",),
        query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_create_schedule",
        description=(
            "Create a project schedule. rule is once/daily/weekly/monthly/cron; "
            "task_template must contain title."
        ),
        method="POST", path="/api/schedule/create",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "workflow_id": {"type": "string", "description": "workflow id"},
            "name": {"type": "string", "description": "schedule name"},
            "task_template": {"type": "object", "description": "task template; must include title"},
            "rule": {"type": "object", "description": "structured schedule rule"},
            "execution_mode": {"type": "string", "description": "workflow/immediate/manual"},
            "overlap_policy": {"type": "string", "description": "skip/parallel/queue"},
        },
        required=("project_id", "workflow_id", "name", "task_template", "rule"),
        read_only=False, side_effect="create and enable a project schedule",
        query_params=("project_id",),
        body_params=("workflow_id", "name", "task_template", "rule", "execution_mode", "overlap_policy"),
    ),
    WorkstepTool(
        name="workstep_update_schedule",
        description="Update an existing project schedule and recalculate its next run.",
        method="PATCH", path="/api/schedule/{schedule_id}",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "schedule_id": {"type": "string", "description": "schedule id"},
            "name": {"type": "string", "description": "new name"},
            "workflow_id": {"type": "string", "description": "new workflow id"},
            "task_template": {"type": "object", "description": "complete task template"},
            "rule": {"type": "object", "description": "structured schedule rule"},
            "execution_mode": {"type": "string", "description": "workflow/immediate/manual"},
            "overlap_policy": {"type": "string", "description": "skip/parallel/queue"},
        },
        required=("project_id", "schedule_id"), read_only=False,
        side_effect="update and recalculate a project schedule",
        path_params=("schedule_id",), query_params=("project_id",),
        body_params=("name", "workflow_id", "task_template", "rule", "execution_mode", "overlap_policy"),
    ),
    *[
        WorkstepTool(
            name=f"workstep_{action}_schedule",
            description=f"{action.title()} one project schedule.",
            method="POST" if action != "delete" else "DELETE",
            path=f"/api/schedule/{{schedule_id}}/{action}" if action != "delete" else "/api/schedule/{schedule_id}",
            parameters={
                "project_id": {"type": "string", "description": "project id"},
                "schedule_id": {"type": "string", "description": "schedule id"},
            },
            required=("project_id", "schedule_id"), read_only=False,
            side_effect={"pause": "pause the schedule", "resume": "resume the schedule", "delete": "delete the schedule and its run logs"}[action],
            path_params=("schedule_id",), query_params=("project_id",),
        )
        for action in ("pause", "resume", "delete")
    ],
    WorkstepTool(
        name="workstep_list_schedule_runs",
        description="List execution logs of one project schedule.",
        method="GET", path="/api/schedule/{schedule_id}/runs",
        parameters={
            "project_id": {"type": "string", "description": "project id"},
            "schedule_id": {"type": "string", "description": "schedule id"},
            "limit": {"type": "integer", "description": "result count; default 50"},
            "offset": {"type": "integer", "description": "pagination offset"},
        },
        required=("project_id", "schedule_id"), path_params=("schedule_id",),
        query_params=("project_id", "limit", "offset"),
    ),
]

TOOL_BY_NAME: dict[str, WorkstepTool] = {
    tool.name: tool for tool in WORKSTEP_TOOLS
}


def tool_documentation() -> str:
    """Markdown documentation agents can read to learn the available tools."""
    lines = [
        "# WorkStep internal tools",
        "",
        "You can manage the WorkStep system by calling `workstep_call` with an "
        "operation and JSON arguments. Operations:",
        "",
    ]
    for tool in WORKSTEP_TOOLS:
        lines.append(f"## {tool.name}")
        lines.append(f"- Purpose: {tool.description}")
        if tool.parameters:
            params = ", ".join(
                f"{key} ({value.get('description', key)})"
                for key, value in tool.parameters.items()
            )
            lines.append(f"- Parameters: {params}")
        if tool.required:
            lines.append(f"- Required: {', '.join(tool.required)}")
        if not tool.read_only:
            lines.append(f"- Side effect: {tool.side_effect or 'has side effects'}")
            lines.append(
                "- Mutating calls require confirm='yes' and explicit user intent."
            )
        lines.append("")
    lines.append(
        "Rules: read-only operations are safe to use for inspection. Mutating "
        "operations require confirm='yes' and explicit user intent. "
        "Never fabricate ids — look them up first with the list/get operations."
    )
    return "\n".join(lines)


def workstep_tools_instruction() -> str:
    """Prompt section teaching an agent the WorkStep tools and their rules."""
    return (
        tool_documentation()
        + "\n\n"
        "Rules: read-only operations (list/get) may be used directly. "
        "Create, update, pause, resume, and delete operations have side effects; "
        "use them only with explicit user authorization and confirm='yes'. "
        "Never invent ids; look them up with list/get first."
    )


def workstep_cli_instruction() -> str:
    """Prompt section teaching CLI engines to call the ``workstep`` CLI.

    Engines without native tool hosting (Codex CLI, Claude Code, Hermes, …)
    call the local daemon through the ``workstep`` CLI instead; the daemon is
    already running when the coordinator turn executes.
    """
    daemon_dir = Path(__file__).resolve().parent.parent
    return (
        "# WorkStep CLI\n"
        "\n"
        "You can inspect and manage the WorkStep system by calling the local "
        "daemon CLI (the daemon is already running). Runtime-safe invocation:\n"
        "\n"
        "    \"$WORKSTEP_CLI_PYTHON\" \"$WORKSTEP_DAEMON_DIR/cli.py\" <command>\n"
        "\n"
        "PowerShell:\n"
        "\n"
        "    & $env:WORKSTEP_CLI_PYTHON \"$env:WORKSTEP_DAEMON_DIR/cli.py\" <command>\n"
        "\n"
        "Source-checkout fallback:\n"
        "\n"
        f"    cd {daemon_dir} && uv run --no-sync python -m cli <command>\n"
        "\n"
        "Read-only commands:\n"
        "- `workstep project list` — list registered projects\n"
        "- `workstep workflow list --project <project_id>` — list project workflows\n"
        "- `workstep workflow get --project <project_id> --workflow <workflow_id>` — get one workflow and its steps\n"
        "- `workstep task list --project <project_id>` — list tasks of a project\n"
        "- `workstep task get --project <project_id> --task <task_id>` — get one task\n"
        "- `workstep task repos --project <project_id>` — list Git repositories in a project\n"
        "- `workstep task worktrees --project <project_id> --task <task_id>` — list only this task's worktrees\n"
        "- `workstep engine list` — list installed LLM engines\n"
        "- `workstep schedule list --project <project_id>` — list schedules\n"
        "- `workstep schedule get --project <project_id> --schedule <schedule_id>` — get one schedule\n"
        "- `workstep schedule runs --project <project_id> --schedule <schedule_id>` — list schedule runs\n"
        "\n"
        "Create a task in a chosen workflow with `workstep task create "
        "--project <project_id> --workflow <workflow_id> --title <title>`; "
        "add `--start-step <step_key>` when a non-default starting step is needed.\n"
        "For a task that needs isolated changes in selected repositories, use "
        "`workstep task worktree-add --project <project_id> --task <task_id> "
        "--repository <repository_id> --alias <directory_name> [--base <source_branch>] "
        "[--branch <new_branch>]` "
        "after inspecting `task repos`. Do not create worktrees for unrelated repositories.\n"
        "\n"
        "Mutating commands (`project init`, `task create`, `schedule "
        "worktree-add`, `schedule create/update/pause/resume/delete`) must only be run with explicit "
        "user authorization. Never fabricate ids — look them up with the "
        "list/get commands first.\n"
    )


class WorkstepClient:
    """HTTP client for calling WorkStep daemon endpoints as tools."""

    def __init__(
        self,
        base_url: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.base_url = (
            base_url
            or os.environ.get("WORKSTEP_DAEMON_URL")
            or DEFAULT_DAEMON_URL
        ).rstrip("/")
        self._transport = transport

    async def call(
        self,
        operation: str,
        arguments: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        tool = TOOL_BY_NAME.get(operation)
        if tool is None:
            return {"ok": False, "error": f"未知操作：{operation}"}
        args = dict(arguments or {})
        missing = [
            key for key in tool.required
            if not args.get(key) or str(args[key]).strip() == ""
        ]
        if missing:
            return {
                "ok": False,
                "error": f"缺少必填参数：{'、'.join(missing)}",
            }
        if not tool.read_only and args.get("confirm") != "yes":
            return {
                "ok": False,
                "error": (
                    f"{tool.name} 有副作用（{tool.side_effect}），"
                    "必须携带 confirm='yes' 且仅当用户明确要求时执行"
                ),
            }

        if tool.name == "workstep_get_project":
            listing = await self.call("workstep_list_projects", {})
            if not listing.get("ok", True):
                return listing
            for proj in listing.get("projects", []):
                if proj.get("id") == args.get("project_id"):
                    return proj
            return {
                "ok": False,
                "error": f"项目不存在：{args.get('project_id')}",
            }

        if tool.name == "workstep_create_task" and not args.get("cwd"):
            project = await self.call(
                "workstep_get_project", {"project_id": args["project_id"]}
            )
            if "path" not in project:
                return {
                    "ok": False,
                    "error": (
                        "无法解析项目路径："
                        f"{project.get('error', '项目不存在')}"
                    ),
                }
            args["cwd"] = project["path"]

        url = tool.path
        for param in tool.path_params:
            url = url.replace("{" + param + "}", str(args.pop(param)))
        query = {
            key: args.pop(key)
            for key in tool.query_params
            if key in args and args[key] not in (None, "")
        }
        body = {
            key: args.pop(key)
            for key in tool.body_params
            if key in args and args[key] not in (None, "")
        }
        async with httpx.AsyncClient(
            base_url=self.base_url,
            transport=self._transport,
            timeout=130.0 if tool.name == "workstep_add_task_worktree" else 30.0,
            headers=(
                {"X-WorkStep-Desktop-Token": os.environ["WORKSTEP_DESKTOP_TOKEN"]}
                if os.environ.get("WORKSTEP_DESKTOP_TOKEN")
                else None
            ),
        ) as client:
            try:
                response = await client.request(
                    tool.method,
                    url,
                    params=query,
                    json=body or None,
                )
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                detail = ""
                try:
                    detail = str(exc.response.json().get("detail", ""))
                except Exception:
                    detail = exc.response.text[:300]
                return {
                    "ok": False,
                    "error": detail or f"HTTP {exc.response.status_code}",
                }
            except httpx.RequestError as exc:
                return {
                    "ok": False,
                    "error": f"无法连接 daemon（{self.base_url}）：{exc}",
                }
        return response.json()
