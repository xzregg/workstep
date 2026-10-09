"""Project service — init, register, and manage project workspaces."""

import asyncio
import json
import logging
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, TypeVar

import peewee as pw

from models import (
    init_db,
    Task,
    TaskStep,
    Workflow,
)
from models.chat_session import ChatSession, ProjectSetting
from models.gen_session import WorkflowGenSession
from models.channel import Channel
from services.project_database import ProjectDatabaseExecutor
from services.project_scope import assert_within_projects_root
from services.project_workflows import ProjectWorkflowService
from services.project_storage import data_directory, read_identity, write_identity, external_directory, relocate_snapshot
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
    follow_project: bool = True
    storage_changing: bool = False
    database_executor: ProjectDatabaseExecutor = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.database_executor = ProjectDatabaseExecutor(
            self.db,
            self.id or self.path.name,
        )

    @property
    def workstep_dir(self) -> Path:
        return self.path / settings.workstep_dir if self.follow_project else external_directory(self.id)

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
        raise RuntimeError("Async database activation is unsafe; use project_manager.run_db")

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        self.__exit__(exc_type, exc_val, exc_tb)


class ProjectManager:
    """Manages multiple project workspaces.

    Each project has its own .workstep/ directory with workstep.db.
    The manager holds open DB connections for all registered projects.
    """

    def __init__(self):
        self._projects: dict[str, Project] = {}  # path_str -> Project
        self._workflow_service = ProjectWorkflowService()

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
        registered_ids = {project.id for project in self._projects.values()}
        for entry in existing_by_path.values():
            if entry.get("id") in registered_ids:
                continue
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
            if project.storage_changing:
                raise ValueError("项目数据正在迁移，请稍后重试")
            with ProjectContext(project):
                return operation(project)

        return await project.database_executor.run(execute)

    # ── Project identity and workflow delegation ─────────────────────

    def _restore_project_identity(self, proj: Project, project_id: str | None = None) -> None:
        """Keep project-scoped rows reachable after removing the global registry entry."""
        identity = read_identity(proj.path)
        saved_id = identity.get("id")
        if not project_id and not saved_id:
            # Older workspaces kept their identity only in project-scoped rows.
            for model in (ChatSession, WorkflowGenSession, ProjectSetting, Channel):
                row = model.select(model.project_id).where(model.project_id != "").first()
                if row:
                    saved_id = row.project_id
                    break
        proj.id = project_id or saved_id or proj.id
        proj.follow_project = identity.get("follow_project", proj.follow_project)
        write_identity(proj.path, proj.id, proj.follow_project)

    # Workflow operations run only in the caller's activated project database.
    def create_workflow(self, proj: Project, name: str, steps: dict | None = None,
                        is_default: bool = False) -> dict:
        return self._workflow_service.create_workflow(proj, name, steps, is_default)

    def reorder_workflows(self, proj: Project, ordered_ids: list[str]) -> None:
        self._workflow_service.reorder_workflows(proj, ordered_ids)

    def update_workflow(self, proj: Project, workflow_id: str,
                        name: str | None = None, steps: dict | None = None) -> dict | None:
        return self._workflow_service.update_workflow(proj, workflow_id, name, steps)

    def delete_workflow(self, proj: Project, workflow_id: str) -> dict | None:
        return self._workflow_service.delete_workflow(proj, workflow_id)

    def restore_workflow(self, proj: Project, workflow_id: str) -> dict | None:
        return self._workflow_service.restore_workflow(proj, workflow_id)

    def workflow_has_running_tasks(self, workflow_id: str) -> bool:
        return self._workflow_service.workflow_has_running_tasks(workflow_id)

    def workflow_has_failed_tasks(self, workflow_id: str) -> bool:
        return self._workflow_service.workflow_has_failed_tasks(workflow_id)

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

    def init_project(self, path: str | Path, name: str | None = None, follow_project: bool = True) -> Project:
        """Initialize a new WorkStep project at the given path.

        Creates:
        - .workstep/ directory
        - .workstep/workstep.db (SQLite with schema)

        Args:
            path: Project root directory
            name: Display name (defaults to directory name)

        Returns the Project instance.
        """
        path = assert_within_projects_root(path)
        path_str = str(path)

        if path_str in self._projects:
            ignore_rule = f"{settings.workstep_dir.rstrip('/')}/"
            _ensure_ignore_rule(path, ".gitignore", ignore_rule)
            _ensure_ignore_rule(path, ".dockerignore", ignore_rule)
            return self._projects[path_str]

        identity = read_identity(path)
        if identity or (path / settings.workstep_dir / "workstep.db").exists():
            project = self.register(path, name=name)
            self._save_config()
            return project
        project_id = str(uuid.uuid4())
        ws_dir = path / settings.workstep_dir if follow_project else external_directory(project_id)
        if ws_dir.exists() and any(ws_dir.iterdir()):
            raise ValueError("项目数据目录非空，不能覆盖")
        ws_dir.mkdir(parents=True, exist_ok=True)

        ignore_rule = f"{settings.workstep_dir.rstrip('/')}/"
        _ensure_ignore_rule(path, ".gitignore", ignore_rule)
        _ensure_ignore_rule(path, ".dockerignore", ignore_rule)

        # Initialize SQLite DB
        db_path = ws_dir / "workstep.db"
        db = init_db(str(db_path))

        project = Project(path=path, db=db, steps={}, name=name or path.name, id=project_id, follow_project=follow_project)
        self._projects[path_str] = project

        # Load existing workflows; new projects start empty.
        with ProjectContext(project):
            self._restore_project_identity(project)
            self._workflow_service._sync_project_workflows(project)

        self._save_config()
        logger.info("Initialized project: %s (name=%s, id=%s)", path_str, project.name, project.id)
        return project

    async def set_storage(self, project_id: str, follow_project: bool) -> dict:
        project = self.get_project_by_id(project_id)
        if project is None:
            raise ValueError("项目不存在")
        if project.storage_changing:
            raise ValueError("项目数据正在迁移，请稍后重试")
        if project.follow_project == follow_project:
            return {"follow_project": follow_project, "data_path": str(project.workstep_dir)}
        from services.concurrency import concurrency_gate
        counts = concurrency_gate.active_count(project_id)
        if counts["tasks_running"] or counts["chats_running"]:
            raise ValueError("项目有运行中的任务或会话，不能迁移")
        project.storage_changing = True

        def migrate():
            from models.action_run import ActionRun
            from models.chat_session import ChatMessage
            from models.coordinator import CoordinatorTurn
            if (Task.select().where(Task.status == "running").exists()
                    or ChatMessage.select().where(ChatMessage.status == "running").exists()
                    or CoordinatorTurn.select().where(CoordinatorTurn.status.in_(["queued", "running"])).exists()
                    or ActionRun.select().where(ActionRun.status.in_(["preparing", "running"])).exists()):
                raise ValueError("项目有运行中的任务或会话，不能迁移")
            source = project.workstep_dir
            target = project.path / settings.workstep_dir if follow_project else external_directory(project.id)
            if target.is_symlink():
                raise ValueError("数据目录不能是符号链接")
            if target.exists() and any(p.name != "project.json" for p in target.iterdir()):
                raise ValueError("目标数据目录非空，不能覆盖")
            if any(p.name == ".git" for p in source.rglob(".git")):
                raise ValueError("项目存在 Git 工作区，请移除工作区后再切换存储位置")
            staging = target.with_name(target.name + ".migrating")
            if staging.exists():
                raise ValueError("存在未完成的迁移目录，请检查后重试")
            checkpoint = project.db.execute_sql("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            if checkpoint and checkpoint[0] != 0:
                raise ValueError("数据库仍被占用，请稍后重试")
            project.db.close()
            installed = []
            old_db = project.db
            new_db = None
            previous = project.follow_project
            committed = False
            try:
                shutil.copytree(source, staging, ignore=lambda directory, names: [name for name in names if Path(directory) == source and name in {"project.json", "project.json.tmp"}], symlinks=True)
                target.mkdir(parents=True, exist_ok=True)
                for entry in staging.iterdir():
                    destination = target / entry.name
                    entry.rename(destination)
                    installed.append(destination)
                new_db = init_db(str(target / "workstep.db"))
                from models import StepRun, WorkflowRun
                for model, column in ((StepRun, StepRun.input_snapshot_json), (StepRun, StepRun.io_contract_json), (WorkflowRun, WorkflowRun.routing_state_json)):
                    for row in model.select().where(column.is_null(False)):
                        raw = getattr(row, column.name)
                        try:
                            snapshot = json.loads(raw)
                        except (TypeError, ValueError):
                            continue
                        updated = relocate_snapshot(snapshot, source, target)
                        if updated != snapshot:
                            setattr(row, column.name, json.dumps(updated, ensure_ascii=False))
                            row.save(only=[column])
                if new_db.execute_sql("PRAGMA quick_check").fetchone() != ("ok",):
                    raise ValueError("迁移后的数据库校验失败")
                write_identity(project.path, project.id, follow_project)
                project.db = new_db
                project.database_executor.rebind(new_db)
                project.follow_project = follow_project
                committed = True
            finally:
                if not committed:
                    if new_db is not None and not new_db.is_closed():
                        new_db.close()
                    project.db = old_db
                    project.database_executor.rebind(old_db)
                    old_db.connect(reuse_if_open=True)
                    project.follow_project = previous
                    for entry in installed:
                        if entry.is_dir() and not entry.is_symlink():
                            shutil.rmtree(entry)
                        else:
                            entry.unlink()
                if staging.exists():
                    shutil.rmtree(staging)
            # Identity is committed before removing old files. Failures leave recoverable data.
            try:
                for entry in source.iterdir():
                    if entry.name == "project.json":
                        continue
                    if entry.is_dir() and not entry.is_symlink():
                        shutil.rmtree(entry)
                    else:
                        entry.unlink()
                if previous is False:
                    source.rmdir()
            except OSError:
                logger.warning("Project storage committed; old data requires cleanup: %s", source, exc_info=True)
                return {"follow_project": follow_project, "data_path": str(target),
                        "warning": "存储位置已切换，但旧目录清理未完成，请核对旧目录后手动清理"}
            return {"follow_project": follow_project, "data_path": str(target)}

        try:
            return await project.database_executor.run(migrate)
        finally:
            project.storage_changing = False

    def register(self, path: str | Path, name: str | None = None, project_id: str | None = None) -> Project:
        """Register an existing project path (opens its DB).

        Raises ValueError if the path has no .workstep/ directory.
        """
        path = assert_within_projects_root(path)
        path_str = str(path)

        if path_str in self._projects:
            return self._projects[path_str]

        identity = read_identity(path)
        project_id = identity.get("id") or project_id
        for existing in list(self._projects.values()):
            if project_id and existing.id == project_id:
                if existing.path.exists():
                    raise ValueError("项目 ID 已被其他目录使用；复制项目不能同时关联同一份数据")
                self.unregister(existing.id)
        ws_dir = data_directory(path)
        if not ws_dir.exists():
            raise ValueError(f"No {settings.workstep_dir}/ directory at {path}")

        db_path = ws_dir / "workstep.db"
        if not db_path.exists():
            raise ValueError(f"No workstep.db at {db_path}")

        db = init_db(str(db_path))
        project = Project(path=path, db=db, steps={}, name=name or path.name, id=project_id or str(uuid.uuid4()), follow_project=identity.get("follow_project", True))
        self._projects[path_str] = project

        # Restore existing workflows without seeding empty projects.
        with ProjectContext(project):
            self._restore_project_identity(project, project_id)
            self._workflow_service._sync_project_workflows(project)

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

        Persist the local project order and the combined local and remote
        sidebar order, retaining unmentioned local projects at the end.
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
        config_store.set("project_order", list(dict.fromkeys(ordered_ids)))

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

    def list_project_catalog(self) -> list[dict[str, str]]:
        """Return registered project identifiers and names without opening databases or paths."""
        return [{"id": project.id, "name": project.name}
                for project in list(self._projects.values())]

    async def running_task_snapshot(self) -> list[dict[str, int | str]]:
        """Count active tasks in each project's database executor."""
        projects = self.list_project_catalog()

        def count_running(_project: Project) -> int:
            return Task.select().where(Task.status == "running").count()

        counts = await asyncio.gather(*(
            self.run_db(project["id"], count_running) for project in projects
        ), return_exceptions=True)
        for count in counts:
            if isinstance(count, BaseException):
                logger.warning("Project runtime count failed: %s", type(count).__name__)
        return [{"id": project["id"], "running_tasks": count}
                for project, count in zip(projects, counts)
                if type(count) is int]

    def provider_references(self, provider_id: str) -> list[dict]:
        """Find every project row that still points at a provider ID.

        Providers live in the global config, but workflows, tasks and chat
        sessions persist their own copies of ``provider_id`` in per-project
        databases. Deleting a provider without checking these leaves dangling
        references that only surface as runtime failures ("供应商不存在") when a
        step or the coordinator tries to resolve them.
        """
        target = str(provider_id or "").strip()
        if not target:
            return []
        references: list[dict] = []
        for path_str, proj in self._projects.items():
            with self.activate_project(path_str):
                for workflow in Workflow.select():
                    try:
                        steps = json.loads(workflow.steps_json or "{}")
                    except (TypeError, json.JSONDecodeError):
                        continue
                    for node in self._iter_workflow_steps(steps):
                        if not isinstance(node, dict):
                            continue
                        for location, config in self._step_provider_configs(node):
                            if str(config.get("provider_id") or "").strip() == target:
                                references.append({
                                    "project_id": proj.id,
                                    "project_name": proj.name,
                                    "kind": "workflow",
                                    "location": (
                                        f"工作流「{workflow.name}」步骤「"
                                        f"{node.get('title') or node.get('type') or node.get('key') or ''}"
                                        f"」{location}"
                                    ),
                                })
                task_rows = Task.select().where(
                    Task.coordinator_provider_id == target
                )
                for task in task_rows:
                    references.append({
                        "project_id": proj.id,
                        "project_name": proj.name,
                        "kind": "task",
                        "location": f"任务「{task.title or task.id}」协调器",
                    })
                task_step_rows = TaskStep.select().where(
                    TaskStep.execution_config_json.contains(target)
                )
                for step in task_step_rows:
                    try:
                        override = json.loads(step.execution_config_json or "{}")
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if not isinstance(override, dict):
                        continue
                    if (
                        str((override.get("config") or {}).get("provider_id") or "").strip()
                        == target
                    ):
                        references.append({
                            "project_id": proj.id,
                            "project_name": proj.name,
                            "kind": "task_step",
                            "location": f"任务步骤「{step.step_key}」执行配置",
                        })
                for session in ChatSession.select().where(
                    ChatSession.provider_id == target
                ):
                    references.append({
                        "project_id": proj.id,
                        "project_name": proj.name,
                        "kind": "chat_session",
                        "location": f"会话「{session.title or session.id}」",
                    })
        return references

    @staticmethod
    def _iter_workflow_steps(steps: object):
        """Yield workflow step nodes from either the nodes or legacy steps form."""
        if not isinstance(steps, dict):
            return
        raw_steps = steps.get("nodes") or steps.get("steps") or []
        if isinstance(raw_steps, list):
            for node in raw_steps:
                yield node

    @staticmethod
    def _step_provider_configs(node: dict):
        """Yield (location, config) pairs that may carry a provider override."""
        config = node.get("config")
        if isinstance(config, dict):
            yield ("执行配置", config)
        review = node.get("review")
        if isinstance(review, dict):
            review_config = review.get("config")
            if isinstance(review_config, dict):
                yield ("评审配置", review_config)

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
            "follow_project": proj.follow_project,
            "data_path": str(proj.workstep_dir),
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
