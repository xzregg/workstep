"""Project service — init, register, and manage project workspaces."""

import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import peewee as pw

from models import init_db, Task, TaskStep, Message, ALL_MODELS
from settings import settings

logger = logging.getLogger(__name__)

# Global config: ~/.workstep/config.json
GLOBAL_CONFIG_DIR = Path.home() / ".workstep"
GLOBAL_CONFIG_FILE = GLOBAL_CONFIG_DIR / "config.json"

# Default workflow template for new projects
DEFAULT_STEPS = {
    "steps": [
        {
            "id": "do",
            "name": "执行",
            "engine": "claude",
            "prompt": "{{input}}",
        }
    ]
}


@dataclass
class Project:
    """A registered WorkStep project."""

    path: Path
    db: pw.SqliteDatabase
    steps: dict  # Parsed steps.json
    name: str = ""  # Display name, defaults to directory name

    @property
    def workstep_dir(self) -> Path:
        return self.path / settings.workstep_dir

    @property
    def db_path(self) -> Path:
        return self.workstep_dir / "workstep.db"

    @property
    def steps_path(self) -> Path:
        return self.workstep_dir / "steps.json"


class ProjectManager:
    """Manages multiple project workspaces.

    Each project has its own .workstep/ directory with steps.json and workstep.db.
    The manager holds open DB connections for all registered projects.
    """

    def __init__(self):
        self._projects: dict[str, Project] = {}  # path_str -> Project

    def _save_config(self):
        """Persist project list to ~/.workstep/config.json."""
        GLOBAL_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        config = {
            "projects": {
                path_str: proj.name
                for path_str, proj in self._projects.items()
            }
        }
        GLOBAL_CONFIG_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2))

    def _load_saved_projects(self):
        """Load and register projects from ~/.workstep/config.json on startup."""
        if not GLOBAL_CONFIG_FILE.exists():
            return
        try:
            config = json.loads(GLOBAL_CONFIG_FILE.read_text())
            projects_data = config.get("projects", {})

            # New format: {path: name}
            if isinstance(projects_data, dict):
                items = projects_data.items()
            # Old format: [{path, name}] or [path_string]
            elif isinstance(projects_data, list):
                items = []
                for entry in projects_data:
                    if isinstance(entry, str):
                        items.append((entry, ""))
                    else:
                        items.append((entry.get("path", ""), entry.get("name", "")))
            else:
                return

            for path_str, name in items:
                path = Path(path_str)
                if path.exists() and (path / settings.workstep_dir).exists():
                    try:
                        self.register(path, name=name or None)
                    except Exception as e:
                        logger.warning("Failed to restore project %s: %s", path_str, e)
                else:
                    logger.warning("Project path no longer exists: %s", path_str)
        except Exception as e:
            logger.warning("Failed to load config: %s", e)

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

        # Read steps
        steps = json.loads(steps_path.read_text())

        project = Project(path=path, db=db, steps=steps, name=name or path.name)
        self._projects[path_str] = project
        self._save_config()
        logger.info("Initialized project: %s (name=%s)", path_str, project.name)
        return project

    def register(self, path: str | Path, name: str | None = None) -> Project:
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
        steps = json.loads(steps_path.read_text()) if steps_path.exists() else DEFAULT_STEPS

        project = Project(path=path, db=db, steps=steps, name=name or path.name)
        self._projects[path_str] = project
        logger.info("Registered project: %s", path_str)
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
        for path_str, proj in self._projects.items():
            result.append({
                "path": path_str,
                "name": proj.name,
                "steps": proj.steps,
            })
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
