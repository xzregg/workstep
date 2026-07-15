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

    def init_project(self, path: str | Path) -> Project:
        """Initialize a new WorkStep project at the given path.

        Creates:
        - .workstep/ directory
        - .workstep/steps.json (default template)
        - .workstep/workstep.db (SQLite with schema)

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

        project = Project(path=path, db=db, steps=steps)
        self._projects[path_str] = project
        logger.info("Initialized project: %s", path_str)
        return project

    def register(self, path: str | Path) -> Project:
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

        project = Project(path=path, db=db, steps=steps)
        self._projects[path_str] = project
        logger.info("Registered project: %s", path_str)
        return project

    def list_projects(self) -> list[dict]:
        """List all registered projects."""
        result = []
        for path_str, proj in self._projects.items():
            result.append({
                "path": path_str,
                "name": proj.path.name,
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
