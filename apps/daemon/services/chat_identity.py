"""Project-addressable WorkStep chat IDs (independent of engine thread IDs)."""

import re
import uuid


_PROJECT_SESSION = re.compile(
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z"
)


def new_session_id(project_id: str) -> str:
    return project_id + "-" + str(uuid.uuid4()).split("-", 1)[1]


def session_project_id(session_id: str) -> str | None:
    match = _PROJECT_SESSION.fullmatch(session_id)
    return match.group(1) if match else None
