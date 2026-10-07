"""Project authorization and optional container filesystem boundary."""

import os
from pathlib import Path

from workstep_gateway_protocol import project_http_route_allowed


def project_http_allowed(method: str, path: str, query: list[tuple[str, str]], project_id: str, access_level: str,
                         task_create: bool = False) -> bool:
    if access_level not in ("read", "edit"):
        return False
    return project_http_route_allowed(method, path, query,
                                      project_id, access_level=access_level,
                                      task_create=task_create)


def require_catalog_project(project_id: str) -> bool:
    """Validate the actor as well as the tunnel route; return whether to redact."""
    from services.remote_access import get_current_actor

    actor = get_current_actor()
    if actor and actor.project_id is not None:
        if project_id != actor.project_id:
            raise PermissionError("项目范围不匹配")
        return True
    return False


def workspace_engine_catalog(items: list[dict]) -> list[dict]:
    """Only capability metadata and step schemas belong in a project workspace."""
    keys = ("id", "default_model", "installed", "configured", "verified", "built_in",
            "version", "mode", "provider_protocols", "supports_resume", "supports_session_fork",
            "supports_coordinator", "supports_tool_disable", "supports_native_schema",
            "supports_live_step_message", "supports_provider", "supports_sessions",
            "supports_tool_approval", "supports_workstep_tools", "supports_controlled_skills")
    result = []
    for item in items:
        public = {key: item[key] for key in keys if key in item}
        public.update(binary_path=None, configured_path=None, install_command=None,
                      update_command=None, installable=False, updatable=False,
                      runtime_manageable=False)
        schema = item.get("config")
        public["config"] = ({"fields": [], "values": {}, "secrets": {},
                             "step_fields": [field for field in schema.get("step_fields", [])
                                             if not field.get("sensitive")]}
                            if isinstance(schema, dict) else None)
        result.append(public)
    return result


def projects_root() -> Path | None:
    value = os.environ.get("WORKSTEP_PROJECTS_ROOT", "").strip()
    return Path(value).expanduser().resolve() if value else None


def assert_within_projects_root(path: str | Path) -> Path:
    resolved = Path(path).expanduser().resolve()
    root = projects_root()
    if root is not None and not resolved.is_relative_to(root):
        raise ValueError(f"Project path must be inside {root}")
    return resolved
