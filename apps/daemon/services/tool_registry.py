"""WorkStep internal tool registry.

Exposes daemon REST endpoints as structured tools that Agent helpers can load
on demand (CLI and engine-injected tools share ``WorkstepClient``). The client
talks HTTP to the local daemon, so tool behavior always matches the frontend's
API contract.
"""

import json
import os
from dataclasses import dataclass, field
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
        parameters={"project_id": {"type": "string", "description": "项目 id"}},
        required=("project_id",),
        read_only=True,
    ),
    WorkstepTool(
        name="workstep_list_tasks",
        description=(
            "List tasks of a project (optionally archived), including status, "
            "stage progress and workflow info."
        ),
        method="GET",
        path="/api/task/list",
        parameters={
            "project_id": {"type": "string", "description": "项目 id"},
            "archived": {"type": "boolean", "description": "只看已归档任务，默认 false"},
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
            "project_id": {"type": "string", "description": "项目 id"},
            "task_id": {"type": "string", "description": "任务 id"},
        },
        required=("project_id", "task_id"),
        read_only=True,
        path_params=("task_id",),
        query_params=("project_id",),
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
            "path": {"type": "string", "description": "项目目录绝对路径"},
            "name": {"type": "string", "description": "项目名称，缺省用目录名"},
        },
        required=("path",),
        read_only=False,
        side_effect="初始化项目目录并注册到 WorkStep",
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
            "project_id": {"type": "string", "description": "项目 id"},
            "title": {"type": "string", "description": "任务标题"},
            "cwd": {"type": "string", "description": "工作目录，缺省为项目路径"},
            "description": {"type": "string", "description": "任务说明（可选）"},
        },
        required=("project_id", "title"),
        read_only=False,
        side_effect="在项目中新建一个任务",
        query_params=("project_id",),
        body_params=("title", "cwd", "description"),
    ),
    WorkstepTool(
        name="workstep_list_schedules",
        description="List project schedules with status and next run time.",
        method="GET", path="/api/schedule/list",
        parameters={"project_id": {"type": "string", "description": "项目 id"}},
        required=("project_id",), query_params=("project_id",),
    ),
    WorkstepTool(
        name="workstep_get_schedule",
        description="Get one project schedule and its normalized rule.",
        method="GET", path="/api/schedule/{schedule_id}",
        parameters={
            "project_id": {"type": "string", "description": "项目 id"},
            "schedule_id": {"type": "string", "description": "定时任务 id"},
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
            "project_id": {"type": "string", "description": "项目 id"},
            "workflow_id": {"type": "string", "description": "流程 id"},
            "name": {"type": "string", "description": "定时配置名称"},
            "task_template": {"type": "object", "description": "任务模板，必须含 title"},
            "rule": {"type": "object", "description": "结构化时间规则"},
            "execution_mode": {"type": "string", "description": "workflow/immediate/manual"},
            "overlap_policy": {"type": "string", "description": "skip/parallel/queue"},
        },
        required=("project_id", "workflow_id", "name", "task_template", "rule"),
        read_only=False, side_effect="创建并启用项目定时任务",
        query_params=("project_id",),
        body_params=("workflow_id", "name", "task_template", "rule", "execution_mode", "overlap_policy"),
    ),
    WorkstepTool(
        name="workstep_update_schedule",
        description="Update an existing project schedule and recalculate its next run.",
        method="PATCH", path="/api/schedule/{schedule_id}",
        parameters={
            "project_id": {"type": "string", "description": "项目 id"},
            "schedule_id": {"type": "string", "description": "定时任务 id"},
            "name": {"type": "string", "description": "新名称"},
            "workflow_id": {"type": "string", "description": "新流程 id"},
            "task_template": {"type": "object", "description": "完整任务模板"},
            "rule": {"type": "object", "description": "结构化时间规则"},
            "execution_mode": {"type": "string", "description": "workflow/immediate/manual"},
            "overlap_policy": {"type": "string", "description": "skip/parallel/queue"},
        },
        required=("project_id", "schedule_id"), read_only=False,
        side_effect="修改并重新计算项目定时任务",
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
                "project_id": {"type": "string", "description": "项目 id"},
                "schedule_id": {"type": "string", "description": "定时任务 id"},
            },
            required=("project_id", "schedule_id"), read_only=False,
            side_effect={"pause": "暂停定时任务", "resume": "恢复定时任务", "delete": "删除定时任务及其调度日志"}[action],
            path_params=("schedule_id",), query_params=("project_id",),
        )
        for action in ("pause", "resume", "delete")
    ],
    WorkstepTool(
        name="workstep_list_schedule_runs",
        description="List execution logs of one project schedule.",
        method="GET", path="/api/schedule/{schedule_id}/runs",
        parameters={
            "project_id": {"type": "string", "description": "项目 id"},
            "schedule_id": {"type": "string", "description": "定时任务 id"},
            "limit": {"type": "integer", "description": "返回数量，默认 50"},
            "offset": {"type": "integer", "description": "分页偏移"},
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
        lines.append(f"- 用途：{tool.description}")
        if tool.parameters:
            params = "、".join(
                f"{key}（{value.get('description', key)}）"
                for key, value in tool.parameters.items()
            )
            lines.append(f"- 参数：{params}")
        if tool.required:
            lines.append(f"- 必填：{'、'.join(tool.required)}")
        if not tool.read_only:
            lines.append(f"- 副作用：{tool.side_effect or '有副作用'}")
            lines.append("- 调用必须携带 confirm='yes'，且仅当用户明确要求执行该操作")
        lines.append("")
    lines.append(
        "Rules: read-only operations are safe to use for inspection. Mutating "
        "mutating operations require confirm='yes' and explicit user intent. "
        "Never fabricate ids — look them up first with the list/get operations."
    )
    return "\n".join(lines)


def workstep_tools_instruction() -> str:
    """Prompt section teaching an agent the WorkStep tools and their rules."""
    return (
        tool_documentation()
        + "\n\n"
        "使用约束：只读操作（list/get）可直接用于查询；创建、修改、暂停、"
        "恢复和删除操作有副作用，必须携带 confirm='yes'，且仅当用户明确"
        "授权时才可调用。不要编造 id —— 先用 list/get 查出来。"
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
            timeout=30.0,
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
