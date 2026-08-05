"""Project service — init, register, and manage project workspaces."""

import json
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import peewee as pw

from models import init_db, Task, TaskStep, Message, Workflow, ALL_MODELS
from models.fields import utc_now
from settings import settings

logger = logging.getLogger(__name__)

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
    steps: dict  # Cached steps from the default workflow (backward compatible)
    workflows: list[dict] = field(default_factory=list)  # [{id, name, is_default, steps, ...}]
    name: str = ""  # Display name, defaults to directory name
    id: str = ""  # Unique project ID

    @property
    def workstep_dir(self) -> Path:
        return self.path / settings.workstep_dir

    @property
    def db_path(self) -> Path:
        return self.workstep_dir / "workstep.db"

    @property
    def steps_path(self) -> Path:
        return self.workstep_dir / "steps.json"

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

    Each project has its own .workstep/ directory with steps.json and workstep.db.
    The manager holds open DB connections for all registered projects.
    """

    def __init__(self):
        self._projects: dict[str, Project] = {}  # path_str -> Project

    def _save_config(self):
        """Persist project list to config store.

        Merges in-memory projects with existing config to avoid losing
        entries whose paths are temporarily unavailable.
        """
        existing = config_store.get("projects") or []
        existing_by_path = {e["path"]: e for e in existing if isinstance(e, dict)}

        # Update with in-memory projects
        for path_str, proj in self._projects.items():
            existing_by_path[path_str] = {"id": proj.id, "path": path_str, "name": proj.name}

        config_store.set("projects", list(existing_by_path.values()))

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

    def activate_project_by_id(self, project_id: str) -> ProjectContext:
        """Return a scoped database activation for a project ID."""
        proj = self.get_project_by_id(project_id)
        if not proj:
            raise ValueError(f"Project not found: {project_id}")
        return ProjectContext(proj)

    # ── Workflow helpers ──────────────────────────────────────────────

    def _load_workflows_from_db(self) -> list[dict]:
        """Load all workflow rows from the project DB into dicts."""
        rows = list(Workflow.select().order_by(Workflow.created_at))
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

    def _maybe_migrate_steps_json(self, proj: Project) -> None:
        """If workflows table is empty, seed it from the legacy steps.json file."""
        if Workflow.select().count() > 0:
            return
        steps_path = proj.steps_path
        steps = json.loads(steps_path.read_text()) if steps_path.exists() else dict(DEFAULT_STEPS)
        now = utc_now()
        wf_id = str(uuid.uuid4())[:8]
        Workflow.create(
            id=wf_id,
            name="默认流程",
            steps_json=json.dumps(steps, ensure_ascii=False),
            is_default=1,
            created_at=now,
            updated_at=now,
        )
        logger.info("Migrated steps.json to workflows table for %s", proj.path)

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
        Workflow.create(
            id=wf_id, name=name,
            steps_json=json.dumps(wf_steps, ensure_ascii=False),
            is_default=1 if is_default else 0,
            created_at=now, updated_at=now,
        )
        self._sync_project_workflows(proj)
        return next(w for w in proj.workflows if w["id"] == wf_id)

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
        self._sync_project_workflows(proj)
        return next((w for w in proj.workflows if w["id"] == workflow_id), None)

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
            # Already in the recycle bin → permanent delete
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
        self._sync_project_workflows(proj)
        return {"deleted": True, "soft": True}
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
        - .workstep/steps.json (default template)
        - .workstep/workstep.db (SQLite with schema)

        Args:
            path: Project root directory
            name: Display name (defaults to directory name)

        Returns the Project instance.
        """
        path = Path(path).resolve()
        path_str = str(path)

        if path_str in self._projects:
            return self._projects[path_str]

        ws_dir = path / settings.workstep_dir
        ws_dir.mkdir(parents=True, exist_ok=True)

        # Write default steps.json if not exists
        steps_path = ws_dir / "steps.json"
        if not steps_path.exists():
            steps_path.write_text(json.dumps(DEFAULT_STEPS, ensure_ascii=False, indent=2))

        # Initialize SQLite DB
        db_path = ws_dir / "workstep.db"
        db = init_db(str(db_path))

        # Read steps from steps.json for initial seed
        steps = json.loads(steps_path.read_text())

        project = Project(path=path, db=db, steps=steps, name=name or path.name, id=str(uuid.uuid4())[:8])
        self._projects[path_str] = project

        # Seed workflows table from steps.json
        with ProjectContext(project):
            self._maybe_migrate_steps_json(project)
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
        steps_path = ws_dir / "steps.json"
        steps = json.loads(steps_path.read_text()) if steps_path.exists() else dict(DEFAULT_STEPS)

        project = Project(path=path, db=db, steps=steps, name=name or path.name, id=project_id or str(uuid.uuid4())[:8])
        self._projects[path_str] = project

        # Auto-migrate legacy steps.json → workflows table, then sync
        with ProjectContext(project):
            self._maybe_migrate_steps_json(project)
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

    def list_projects(self) -> list[dict]:
        """List all registered projects."""
        result = []
        for _path_str, proj in self._projects.items():
            entry = {
                "id": proj.id,
                "path": str(proj.path),
                "name": proj.name,
                "steps": proj.steps,
                "workflows": [
                    {
                        "id": w["id"],
                        "name": w["name"],
                        "is_default": w["is_default"],
                        "deleted": w["deleted"],
                        "nodeCount": len(w.get("steps", {}).get("nodes", []) or w.get("steps", {}).get("steps", [])),
                    }
                    for w in proj.workflows
                ],
            }
            result.append(entry)
        return result

    def get_project(self, path: str | Path) -> Project | None:
        """Get a registered project by path."""
        return self._projects.get(str(Path(path).resolve()))

    def close_all(self):
        """Close all project DB connections."""
        for proj in self._projects.values():
            if not proj.db.is_closed():
                proj.db.close()
        self._projects.clear()


# Global singleton
project_manager = ProjectManager()
