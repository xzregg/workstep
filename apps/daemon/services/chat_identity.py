"""Read project prefixes from legacy WorkStep chat IDs."""

import re


_PROJECT_SESSION = re.compile(
    r"([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)"
    r"-[0-9a-f]{32}\Z"
)
_LEGACY_PROJECT_SESSION = re.compile(
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z"
)


def session_project_id(session_id: str) -> str | None:
    match = _PROJECT_SESSION.fullmatch(session_id) or _LEGACY_PROJECT_SESSION.fullmatch(session_id)
    return match.group(1) if match else None
