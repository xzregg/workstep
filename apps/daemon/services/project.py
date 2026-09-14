"""Project service — init, register, and manage project workspaces."""

import json
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, TypeVar

import peewee as pw

from models import (
    init_db,
    Task,
    TaskStep,
    Message,
    Workflow,
    WorkflowRun,
    StepRun,
    ReviewRun,
    CoordinatorSession,
    CoordinatorTurn,
    ActionProposal,
    StageSupplement,
    Schedule,
    ALL_MODELS,
)
from models.fields import utc_now
from models.chat_session import ChatSession, ProjectSetting
from models.gen_session import WorkflowGenSession
from models.channel import Channel
from services.project_database import ProjectDatabaseExecutor
from settings import settings

logger = logging.getLogger(__name__)
ResultT = TypeVar("ResultT")


def _ensure_ignore_rule(project_path: Path, filename: str, rule: str) -> None:
    """Append an ignore rule without replacing the project's existing entries."""
    ignore_path = project_path / filename
    content = ignore_path.read_text() if ignore_path.exists() else ""
    normalized_rule = rule.rstrip("/")
    if any(line.strip().rstrip("/") == normalized_rule for line in content.splitlines()):
        return
    separator = "" if not content or content.endswith("\n") else "\n"
    ignore_path.write_text(f"{content}{separator}{rule}\n")

# Global config store — single source of truth for ~/.workstep/config.json
from services.config import config_store

# Default workflow template for new projects (canvas-editor format)
DEFAULT_STEPS = {
    "nodes": [
        {"id": 1, "type": "req", "title": "需求", "position": {"x": 100, "y": 200},
         "engine": "claude", "model": "",
         "prompt": "根据业务需求和用户调研，产出 PRD 文档和原型图。明确用户场景、功能点、验收标准。",
         "inputs": [
             {"name": "业务需求", "type": "文档", "outputs": [{"name": "PRD 文档", "type": "Markdown"}, {"name": "原型图", "type": "Figma"}]},
             {"name": "用户调研", "type": "PDF", "outputs": []}],
         "outputs": [{"name": "PRD 文档", "type": "Markdown"}, {"name": "原型图", "type": "Figma"}]},
        {"id": 2, "type": "ui", "title": "UI 设计", "position": {"x": 380, "y": 200},
         "engine": "claude", "model": "",
         "prompt": "根据 PRD 和原型图，设计高保真 UI 界面，产出设计稿和设计规范文档。",
         "inputs": [
             {"name": "PRD 文档", "type": "Markdown", "outputs": [{"name": "UI 设计稿", "type": "Figma"}, {"name": "设计规范", "type": "PDF"}]},
             {"name": "原型图", "type": "Figma", "outputs": []}],
         "outputs": [{"name": "UI 设计稿", "type": "Figma"}, {"name": "设计规范", "type": "PDF"}]},
        {"id": 3, "type": "frontend", "title": "前端开发", "position": {"x": 660, "y": 200},
         "engine": "claude", "model": "",
         "prompt": "根据 UI 设计稿和接口文档，开发前端页面，实现状态管理和单元测试。",
         "inputs": [
             {"name": "UI 设计稿", "type": "Figma", "outputs": [{"name": "前端页面", "type": "React"}, {"name": "状态管理", "type": "Zustand"}, {"name": "单元测试", "type": "Vitest"}]},
             {"name": "接口文档", "type": "JSON", "outputs": []},
             {"name": "组件库", "type": "React", "outputs": []}],
         "outputs": [{"name": "前端页面", "type": "React"}, {"name": "状态管理", "type": "Zustand"}, {"name": "单元测试", "type": "Vitest"}]},
        {"id": 4, "type": "backend", "title": "后端开发", "position": {"x": 940, "y": 200},
         "engine": "codex", "model": "gpt-5.5",
         "prompt": "根据 PRD 和接口文档，开发后端 API 服务，设计数据库表结构。",
         "inputs": [
             {"name": "PRD 文档", "type": "Markdown", "outputs": [{"name": "API 服务", "type": "Go"}, {"name": "数据库", "type": "MySQL"}]},
             {"name": "接口文档", "type": "JSON", "outputs": []}],
         "outputs": [{"name": "API 服务", "type": "Go"}, {"name": "数据库", "type": "MySQL"}]},
        {"id": 5, "type": "test", "title": "测试", "position": {"x": 1220, "y": 200},
         "engine": "codex", "model": "",
         "prompt": "对前端页面和后端 API 进行集成测试，产出测试报告和 Bug 列表。",
         "inputs": [
             {"name": "前端页面", "type": "React", "outputs": [{"name": "测试报告", "type": "HTML"}, {"name": "Bug 列表", "type": "Excel"}]},
             {"name": "API 服务", "type": "Go", "outputs": []}],
         "outputs": [{"name": "测试报告", "type": "HTML"}, {"name": "Bug 列表", "type": "Excel"}]},
        {"id": 6, "type": "deploy", "title": "上线", "position": {"x": 1500, "y": 200},
         "engine": "hermes", "model": "grok-4.3",
         "prompt": "根据测试报告和部署文档，将服务部署到生产环境。",
         "inputs": [
             {"name": "测试报告", "type": "HTML", "outputs": [{"name": "生产环境", "type": "K8s"}]},
             {"name": "部署文档", "type": "Markdown", "outputs": []}],
         "outputs": [{"name": "生产环境", "type": "K8s"}]},
    ],
    "connections": [
        {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
        {"from": 2, "fromPort": 0, "to": 3, "toPort": 0},
        {"from": 2, "fromPort": 1, "to": 3, "toPort": 1},
        {"from": 3, "fromPort": 0, "to": 5, "toPort": 0},
        {"from": 4, "fromPort": 0, "to": 5, "toPort": 1},
        {"from": 5, "fromPort": 0, "to": 6, "toPort": 0},
    ],
}


@dataclass
class Project:
    """A registered WorkStep project."""

    path: Path
    db: pw.SqliteDatabase
    steps: dict  # Cached steps from the default workflow
    workflows: list[dict] = field(default_factory=list)  # [{id, name, is_default, steps, ...}]
    name: str = ""  # Display name, defaults to directory name
    id: str = ""  # Unique project ID
    database_executor: ProjectDatabaseExecutor = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.database_executor = ProjectDatabaseExecutor(
            self.db,
            self.id or self.path.name,
        )

    @property
    def workstep_dir(self) -> Path:
        return self.path / settings.workstep_dir

    @property
    def db_path(self) -> Path:
        return self.workstep_dir / "workstep.db"

    def default_workflow(self) -> dict | None:
        for wf in self.workflows:
            if wf.get("is_default") and not wf.get("deleted"):
                return wf
        for wf in self.workflows:
            if not wf.get("deleted"):
                return wf
        return None

    def workflow_by_id(self, workflow_id: str) -> dict | None:
        return next(
            (
                workflow
                for workflow in self.workflows
                if workflow.get("id") == workflow_id
                and not workflow.get("deleted")
            ),
            None,
        )


@dataclass
class ProjectContext:
    """A scoped activation of one project's database for shared Peewee models."""

    project: Project
    _token: object | None = field(default=None, init=False, repr=False)

    def __enter__(self) -> Project:
        if self._token is not None:
            raise RuntimeError("ProjectContext is already active")
        if self.project.db.is_closed():
            self.project.db.connect(reuse_if_open=True)
        from models import db_proxy
        self._token = db_proxy.activate(self.project.db)
        return self.project

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        from models import db_proxy
        token, self._token = self._token, None
        if token is not None:
            db_proxy.reset(token)

    async def __aenter__(self) -> Project:
        return self.__enter__()

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        self.__exit__(exc_type, exc_val, exc_tb)


class ProjectManager:
    """Manages multiple project workspaces.

    Each project has its own .workstep/ directory with workstep.db.
    The manager holds open DB connections for all registered projects.
    """

    def __init__(self):
        self._projects: dict[str, Project] = {}  # path_str -> Project

    def iter_projects(self):
        """Yield every registered project."""
        return iter(self._projects.values())

    def _save_config(self):
        """Persist project list to config store.

        Writes projects in the current in-memory order with an explicit
        ``sort_order``. Entries whose paths are temporarily unavailable
        keep their relative order at the end.
        """
        existing = config_store.get("projects") or []
        existing_by_path = {e["path"]: e for e in existing if isinstance(e, dict)}

        ordered: list[dict] = []
        for path_str, proj in self._projects.items():
            existing_by_path.pop(path_str, None)
            ordered.append({
                "id": proj.id,
                "path": path_str,
                "name": proj.name,
                "sort_order": len(ordered),
            })
        for entry in existing_by_path.values():
            entry["sort_order"] = len(ordered)
            ordered.append(entry)

        config_store.set("projects", ordered)

    def bind_project(self, path: str | Path) -> "Project":
        """Bind this execution context to a project's database.

        This compatibility API intentionally leaves the project active for the
        caller. New code that needs a bounded lifetime should use
        :meth:`activate_project` instead.
        """
        from models import db_proxy
        path_str = str(Path(path).resolve())
        proj = self._projects.get(path_str)
        if not proj:
            raise ValueError(f"Project not registered: {path_str}")
        if proj.db.is_closed():
            proj.db.connect(reuse_if_open=True)
        db_proxy.activate(proj.db)
        return proj

    def activate_project(self, path: str | Path) -> ProjectContext:
        """Return a context manager that activates a project and then restores."""
        path_str = str(Path(path).resolve())
        proj = self._projects.get(path_str)
        if not proj:
            raise ValueError(f"Project not registered: {path_str}")
        return ProjectContext(proj)

    def get_project_by_id(self, project_id: str) -> "Project | None":
        """Find a project by its unique ID."""
        for proj in self._projects.values():
            if proj.id == project_id:
                return proj
        return None

    def bind_project_by_id(self, project_id: str) -> "Project":
        """Bind this execution context to the project identified by ID."""
        proj = self.get_project_by_id(project_id)
        if not proj:
            raise ValueError(f"Project not found: {project_id}")
        return self.bind_project(str(proj.path))

    def get_project_by_name(self, name: str) -> "Project | None":
        """Find a project by its display name (defaults to directory name)."""
        for proj in self._projects.values():
            if proj.name == name:
                return proj
        return None

    def find_project_for_task(self, task_id: str) -> "Project | None":
        """Locate the project whose database contains the given task.

        Iterates registered projects, briefly activating each project's
        database to probe for the task row. Returns ``None`` if no
        registered project owns the task.
        """
        from models import db_proxy, Task
        for proj in self._projects.values():
            if proj.db.is_closed():
                try:
                    proj.db.connect(reuse_if_open=True)
                except Exception:
                    continue
            token = db_proxy.activate(proj.db)
            try:
                Task.get_by_id(task_id)
                return proj
            except Task.DoesNotExist:
                continue
            finally:
                db_proxy.reset(token)
        return None

    async def find_project_for_task_async(self, task_id: str) -> "Project | None":
        """Locate a task without executing any Peewee query on the event loop."""
        import asyncio

        projects = tuple(self._projects.values())
        matches = await asyncio.gather(*(
            self.run_db(
                project.id,
                lambda _project: Task.get_or_none(Task.id == task_id) is not None,
            )
            for project in projects
        ))
        return next(
            (project for project, matched in zip(projects, matches) if matched),
            None,
        )

    def activate_project_by_id(self, project_id: str) -> ProjectContext:
        """Return a scoped database activation for a project ID."""
        proj = self.get_project_by_id(project_id)
        if not proj:
            raise ValueError(f"Project not found: {project_id}")
        return ProjectContext(proj)

    async def run_db(
        self,
        project_id: str,
        operation: Callable[[Project], ResultT],
    ) -> ResultT:
        """Run one project's complete Peewee work unit off the event loop."""
        project = self.get_project_by_id(project_id)
        if project is None:
            raise ValueError(f"Project not found: {project_id}")

        def execute() -> ResultT:
            with ProjectContext(project):
                return operation(project)

        return await project.database_executor.run(execute)

    # ── Workflow helpers ──────────────────────────────────────────────

    def _load_workflows_from_db(self) -> list[dict]:
        """Load all workflow rows from the project DB into dicts."""
        rows = list(Workflow.select().order_by(Workflow.sort_order, Workflow.created_at))
        result = []
        for r in rows:
            try:
                steps = json.loads(r.steps_json)
            except (json.JSONDecodeError, TypeError):
                steps = {}
            result.append({
                "id": r.id,
                "name": r.name,
                "steps": steps,
                "is_default": bool(r.is_default),
                "deleted": bool(r.deleted),
                "created_at": r.created_at,
                "updated_at": r.updated_at,
            })
        return result

    def _ensure_default_workflow(self, proj: Project) -> None:
        """Seed the database with the built-in default workflow when empty."""
        if Workflow.select().count() > 0:
            return
        now = utc_now()
        wf_id = str(uuid.uuid4())[:8]
        Workflow.create(
            id=wf_id,
            name="默认流程",
            steps_json=json.dumps(DEFAULT_STEPS, ensure_ascii=False),
            is_default=1,
            created_at=now,
            updated_at=now,
        )
        logger.info("Created default workflow for %s", proj.path)

    def _restore_project_identity(self, proj: Project, project_id: str | None = None) -> None:
        """Keep project-scoped rows reachable after removing the global registry entry."""
        identity_path = proj.path / settings.workstep_dir / "project.json"
        identity = json.loads(identity_path.read_text()) if identity_path.exists() else {}
        saved_id = identity.get("id")
        if not project_id and not saved_id:
            # Older workspaces kept their identity only in project-scoped rows.
            for model in (ChatSession, WorkflowGenSession, ProjectSetting, Channel):
                row = model.select(model.project_id).where(model.project_id != "").first()
                if row:
                    saved_id = row.project_id
                    break
        proj.id = project_id or saved_id or proj.id
        identity_path.write_text(json.dumps({"id": proj.id}) + "\n")

    def _sync_project_workflows(self, proj: Project) -> None:
        """Load workflows from DB into the Project dataclass and update cached steps."""
        proj.workflows = self._load_workflows_from_db()
        default = proj.default_workflow()
        if default:
            proj.steps = default["steps"]

    def create_workflow(self, proj: Project, name: str, steps: dict | None = None,
                        is_default: bool = False) -> dict:
        """Create a new workflow and return its dict."""
        if is_default:
            Workflow.update(is_default=0).where(Workflow.is_default == 1).execute()
        now = utc_now()
        wf_id = str(uuid.uuid4())[:8]
        wf_steps = steps if steps is not None else {"nodes": [], "connections": []}
        next_order = (Workflow.select(pw.fn.MAX(Workflow.sort_order)).scalar() or 0) + 1
        Workflow.create(
            id=wf_id, name=name,
            steps_json=json.dumps(wf_steps, ensure_ascii=False),
            is_default=1 if is_default else 0,
            sort_order=next_order,
            created_at=now, updated_at=now,
        )
        self._sync_project_workflows(proj)
        return next(w for w in proj.workflows if w["id"] == wf_id)

    def reorder_workflows(self, proj: Project, ordered_ids: list[str]) -> None:
        """Reassign sort_order from an explicit id list; unknown ids keep their relative order at the end."""
        rows = list(Workflow.select().order_by(Workflow.sort_order, Workflow.created_at))
        by_id = {row.id: row for row in rows}
        seen: set[str] = set()
        ordered: list[Workflow] = []
        for wf_id in ordered_ids:
            row = by_id.get(wf_id)
            if row is not None and wf_id not in seen:
                ordered.append(row)
                seen.add(wf_id)
        for row in rows:
            if row.id not in seen:
                ordered.append(row)
        for index, row in enumerate(ordered):
            if row.sort_order != index:
                row.sort_order = index
                row.save()
        self._sync_project_workflows(proj)

    def update_workflow(self, proj: Project, workflow_id: str,
                        name: str | None = None, steps: dict | None = None) -> dict | None:
        """Update a workflow's name and/or steps. Returns the updated dict or None."""
        row = Workflow.get_or_none(Workflow.id == workflow_id)
        if row is None:
            return None
        if name is not None:
            row.name = name
        if steps is not None:
            row.steps_json = json.dumps(steps, ensure_ascii=False)
        row.updated_at = utc_now()
        row.save()
        if steps is not None:
            self._invalidate_schedules_with_missing_start(workflow_id, steps)
        self._sync_project_workflows(proj)
        return next((w for w in proj.workflows if w["id"] == workflow_id), None)

    def _invalidate_schedules_with_missing_start(
        self, workflow_id: str, steps: dict
    ) -> None:
        from services.workflow_definition import WorkflowDefinition

        step_keys = {
            item["key"]
            for item in WorkflowDefinition.load(steps).compile().to_steps_config()["steps"]
        }
        for schedule in Schedule.select().where(
            (Schedule.workflow_id == workflow_id)
            & (Schedule.status.in_(("active", "paused")))
        ):
            try:
                start_key = json.loads(schedule.task_template_json).get("start_step_key")
            except (json.JSONDecodeError, TypeError):
                start_key = None
            if start_key and start_key not in step_keys:
                schedule.status = "invalid"
                schedule.invalid_reason = f"Start step was removed: {start_key}"
                schedule.next_run_at = None
                schedule.updated_at = utc_now()
                schedule.save()

    def delete_workflow(self, proj: Project, workflow_id: str) -> dict | None:
        """Delete a workflow — two-stage (recycle bin).

        First call soft-deletes (row stays, `deleted=1`); deleting again
        permanently removes the row. The default workflow and the last
        remaining active workflow cannot be deleted.
        """
        row = Workflow.get_or_none(Workflow.id == workflow_id)
        if row is None:
            return None

        if bool(row.deleted):
            # Already in the recycle bin → permanent delete. Clear every
            # record owned by this workflow (tasks, messages, runs, reviews,
            # coordinator data) before removing the workflow row itself.
            self._delete_workflow_data(workflow_id)
            self._invalidate_workflow_schedules(workflow_id)
            self._prune_schedule_candidates(workflow_id)
            row.delete_instance()
            self._sync_project_workflows(proj)
            return {"deleted": True, "soft": False}

        if bool(row.is_default):
            return {"deleted": False, "reason": "default"}
        active_count = Workflow.select().where(Workflow.deleted == 0).count()
        if active_count <= 1:
            return {"deleted": False, "reason": "last"}

        row.deleted = 1
        row.updated_at = utc_now()
        row.save()
        self._invalidate_workflow_schedules(workflow_id)
        self._prune_schedule_candidates(workflow_id)
        self._sync_project_workflows(proj)
        return {"deleted": True, "soft": True}

    def _prune_schedule_candidates(self, workflow_id: str) -> None:
        """Drop a deleted workflow from agent-mode schedule candidates."""
        for schedule in Schedule.select().where(
            Schedule.status.in_(("active", "paused"))
        ):
            try:
                template = json.loads(schedule.task_template_json)
            except (json.JSONDecodeError, TypeError):
                continue
            if str(template.get("mode") or "static") != "agent":
                continue
            original = list(template.get("candidate_workflow_ids") or [])
            candidates = [wid for wid in original if wid != workflow_id]
            if candidates == original:
                continue
            template["candidate_workflow_ids"] = candidates
            schedule.task_template_json = json.dumps(template, ensure_ascii=False)
            schedule.updated_at = utc_now()
            if not candidates:
                schedule.status = "invalid"
                schedule.invalid_reason = (
                    f"Candidate workflow was deleted: {workflow_id}"
                )
                schedule.next_run_at = None
            schedule.save()

    def _invalidate_workflow_schedules(self, workflow_id: str) -> None:
        """Permanently stop schedules whose target workflow is unavailable."""
        Schedule.update(
            status="invalid",
            invalid_reason="Workflow was deleted",
            next_run_at=None,
            updated_at=utc_now(),
        ).where(Schedule.workflow_id == workflow_id).execute()

    def restore_workflow(self, proj: Project, workflow_id: str) -> dict | None:
        """Restore a soft-deleted (recycle bin) workflow. Returns the dict or None."""
        row = Workflow.get_or_none(Workflow.id == workflow_id)
        if row is None or not bool(row.deleted):
            return None
        row.deleted = 0
        row.updated_at = utc_now()
        row.save()
        self._sync_project_workflows(proj)
        return next((w for w in proj.workflows if w["id"] == workflow_id), None)

    def workflow_has_running_tasks(self, workflow_id: str) -> bool:
        """True when any task of the workflow is currently executing."""
        return Task.select().where(
            (Task.workflow_id == workflow_id) & (Task.status == "running")
        ).exists()

    def workflow_has_failed_tasks(self, workflow_id: str) -> bool:
        """True when an active task in the workflow has a failed stage."""
        return (
            TaskStep.select()
            .join(Task)
            .where(
                Task.workflow_id == workflow_id,
                Task.archived == 0,
                TaskStep.status == "failed",
            )
            .exists()
        )

    def _delete_workflow_data(self, workflow_id: str) -> None:
        """Permanently delete every DB record owned by a workflow's tasks.

        Tasks reference their workflow via ``tasks.workflow_id``; all other
        tables cascade through ``tasks`` (messages, task steps, workflow/step
        runs, reviews, coordinator sessions/turns/proposals/supplements), so
        they are removed in FK dependency order before the tasks themselves.
        """
        task_ids = [
            t.id
            for t in Task.select(Task.id).where(Task.workflow_id == workflow_id)
        ]
        if not task_ids:
            return
        tasks = Task.id.in_(task_ids)
        run_ids = [
            r.id
            for r in WorkflowRun.select(WorkflowRun.id).where(
                WorkflowRun.task.in_(task_ids)
            )
        ]
        runs = WorkflowRun.id.in_(run_ids)

        StageSupplement.delete().where(StageSupplement.task.in_(task_ids)).execute()
        ActionProposal.delete().where(ActionProposal.task.in_(task_ids)).execute()
        CoordinatorTurn.delete().where(CoordinatorTurn.task.in_(task_ids)).execute()
        CoordinatorSession.delete().where(CoordinatorSession.task.in_(task_ids)).execute()
        ReviewRun.delete().where(ReviewRun.task.in_(task_ids)).execute()
        StepRun.delete().where(StepRun.run.in_(run_ids)).execute()
        WorkflowRun.delete().where(WorkflowRun.task.in_(task_ids)).execute()
        Message.delete().where(Message.task.in_(task_ids)).execute()
        TaskStep.delete().where(TaskStep.task.in_(task_ids)).execute()
        Task.delete().where(tasks).execute()

        # ── Project lifecycle ────────────────────────────────────────────

    def _load_saved_projects(self):
        """Load and register projects from config store on startup."""
        projects_data = config_store.get("projects")
        if not projects_data:
            return

        try:
            for entry in projects_data:
                if isinstance(entry, str):
                    path_str, name, pid = entry, "", ""
                elif isinstance(entry, dict):
                    path_str = entry.get("path", "")
                    name = entry.get("name", "")
                    pid = entry.get("id", "")
                else:
                    continue

                path = Path(path_str)
                if path.exists() and (path / settings.workstep_dir).exists():
                    try:
                        self.register(path, name=name or None, project_id=pid or None)
                    except Exception as e:
                        logger.warning("Failed to restore project %s: %s", path_str, e)
                else:
                    logger.warning("Project path no longer exists: %s", path_str)
        except Exception as e:
            logger.warning("Failed to load projects from config: %s", e)

    def init_project(self, path: str | Path, name: str | None = None) -> Project:
        """Initialize a new WorkStep project at the given path.

        Creates:
        - .workstep/ directory
        - .workstep/workstep.db (SQLite with schema)

        Args:
            path: Project root directory
            name: Display name (defaults to directory name)

        Returns the Project instance.
        """
        path = Path(path).resolve()
        path_str = str(path)

        if path_str in self._projects:
            ignore_rule = f"{settings.workstep_dir.rstrip('/')}/"
            _ensure_ignore_rule(path, ".gitignore", ignore_rule)
            _ensure_ignore_rule(path, ".dockerignore", ignore_rule)
            return self._projects[path_str]

        ws_dir = path / settings.workstep_dir
        ws_dir.mkdir(parents=True, exist_ok=True)

        ignore_rule = f"{settings.workstep_dir.rstrip('/')}/"
        _ensure_ignore_rule(path, ".gitignore", ignore_rule)
        _ensure_ignore_rule(path, ".dockerignore", ignore_rule)

        # Initialize SQLite DB
        db_path = ws_dir / "workstep.db"
        db = init_db(str(db_path))

        project = Project(path=path, db=db, steps={}, name=name or path.name, id=str(uuid.uuid4())[:8])
        self._projects[path_str] = project

        # Seed the canonical workflows table directly.
        with ProjectContext(project):
            self._restore_project_identity(project)
            self._ensure_default_workflow(project)
            self._sync_project_workflows(project)

        self._save_config()
        logger.info("Initialized project: %s (name=%s, id=%s)", path_str, project.name, project.id)
        return project

    def register(self, path: str | Path, name: str | None = None, project_id: str | None = None) -> Project:
        """Register an existing project path (opens its DB).

        Raises ValueError if the path has no .workstep/ directory.
        """
        path = Path(path).resolve()
        path_str = str(path)

        if path_str in self._projects:
            return self._projects[path_str]

        ws_dir = path / settings.workstep_dir
        if not ws_dir.exists():
            raise ValueError(f"No {settings.workstep_dir}/ directory at {path}")

        db_path = ws_dir / "workstep.db"
        if not db_path.exists():
            raise ValueError(f"No workstep.db at {db_path}")

        db = init_db(str(db_path))
        project = Project(path=path, db=db, steps={}, name=name or path.name, id=project_id or str(uuid.uuid4())[:8])
        self._projects[path_str] = project

        # Ensure the canonical workflows table is usable, then sync the cache.
        with ProjectContext(project):
            self._restore_project_identity(project, project_id)
            self._ensure_default_workflow(project)
            self._sync_project_workflows(project)

        logger.info("Registered project: %s (id=%s)", path_str, project.id)
        return project

    def register_and_save(self, path: str | Path, name: str | None = None) -> Project:
        """Register a project and persist to config."""
        proj = self.register(path, name=name)
        self._save_config()
        return proj

    def rename(self, path: str | Path, name: str) -> Project | None:
        """Rename a registered project. Persists to config."""
        path_str = str(Path(path).resolve())
        proj = self._projects.get(path_str)
        if not proj:
            return None
        proj.name = name
        self._save_config()
        return proj

    def reorder_projects(self, ordered_ids: list[str]) -> None:
        """Reorder registered projects by an explicit id list.

        Unknown ids (e.g. remote projects) keep their relative order at the
        end. Persists the new order to the config store.
        """
        by_id = {proj.id: proj for proj in self._projects.values()}
        ordered = []
        for project_id in ordered_ids:
            proj = by_id.pop(project_id, None)
            if proj is not None:
                ordered.append(proj)
        ordered.extend(by_id.values())
        self._projects = {str(proj.path): proj for proj in ordered}
        self._save_config()

    def unregister(self, project_id: str) -> Project | None:
        """Forget a project without deleting anything from its workspace."""
        proj = self.get_project_by_id(project_id)
        if proj is None:
            return None

        path_str = str(proj.path)
        self._projects.pop(path_str, None)
        proj.database_executor.close()
        if not proj.db.is_closed():
            proj.db.close()

        projects = config_store.get("projects") or []
        config_store.set(
            "projects",
            [
                entry
                for entry in projects
                if not (
                    isinstance(entry, dict)
                    and (entry.get("id") == project_id or entry.get("path") == path_str)
                )
            ],
        )
        self._save_config()
        return proj

    def list_projects(self) -> list[dict]:
        """List all registered projects."""
        result = []
        for path_str, proj in self._projects.items():
            # Each project has its own SQLite DB; activate it while computing
            # per-workflow state (e.g. running tasks) so queries hit the
            # correct database.
            with self.activate_project(path_str):
                result.append(self.project_summary(proj))
        return result

    def project_summary(self, proj: Project) -> dict:
        """Serialize a project while its database is active."""
        workflows = [
            {
                "id": w["id"],
                "name": w["name"],
                "is_default": w["is_default"],
                "deleted": w["deleted"],
                "running": self.workflow_has_running_tasks(w["id"]),
                "failed": self.workflow_has_failed_tasks(w["id"]),
                "nodeCount": len(w.get("steps", {}).get("nodes", []) or w.get("steps", {}).get("steps", [])),
            }
            for w in proj.workflows
        ]
        return {
            "id": proj.id,
            "path": str(proj.path),
            "name": proj.name,
            "steps": proj.steps,
            "workflows": workflows,
        }

    def get_project(self, path: str | Path) -> Project | None:
        """Get a registered project by path."""
        return self._projects.get(str(Path(path).resolve()))

    def close_all(self):
        """Close all project DB connections."""
        for proj in self._projects.values():
            proj.database_executor.close()
            if not proj.db.is_closed():
                proj.db.close()
        self._projects.clear()


# Global singleton
project_manager = ProjectManager()
