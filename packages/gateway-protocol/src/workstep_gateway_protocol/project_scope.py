"""Shared, deny-by-default route map for one published project."""

import re


_TASK_DETAIL = re.compile(r"/api/task/[A-Za-z0-9_-]{1,128}\Z")
_TASK_READ_DETAIL = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/"
    r"(?:execution-report|history|artifacts|reviews|coordinator-config)\Z")
_TASK_STEP_CONFIG = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/step/[A-Za-z0-9_-]{1,128}/config\Z")
_TASK_STEP_HISTORY = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/step/[A-Za-z0-9_-]{1,128}/history\Z")
_TASK_MESSAGE_EVENTS = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/messages/[A-Za-z0-9_-]{1,128}/events\Z")
_WORKFLOW_DETAIL = re.compile(r"/api/workflow/[A-Za-z0-9_-]{1,128}\Z")
_CHAT_SESSION_DETAIL = re.compile(r"/api/chat-sessions/[A-Za-z0-9_-]{1,128}\Z")
_CHAT_MESSAGE_EVENTS = re.compile(
    r"/api/chat-sessions/[A-Za-z0-9_-]{1,128}/messages/"
    r"[A-Za-z0-9_-]{1,128}/events\Z")


def project_http_route_allowed(method: str, path: str,
                               query_pairs: list[tuple[str, str]],
                               project_id: str) -> bool:
    if method != "GET" or not project_id:
        return False
    if path == f"/api/project/{project_id}/summary":
        return not query_pairs
    if path == "/api/search/tasks":
        values = [value for key, value in query_pairs if key == "projectId"]
        return values == [project_id] and all(
            key in ("projectId", "query", "status", "engine", "start_date",
                    "end_date", "limit", "offset") for key, _ in query_pairs)
    values = [value for key, value in query_pairs if key == "project_id"]
    if values != [project_id]:
        return False
    if path == "/api/task/list":
        return all(key in ("project_id", "workflow_id", "archived")
                   for key, _ in query_pairs)
    if _TASK_DETAIL.fullmatch(path):
        return len(query_pairs) == 1
    if (_TASK_READ_DETAIL.fullmatch(path) or _TASK_STEP_CONFIG.fullmatch(path)
            or _TASK_STEP_HISTORY.fullmatch(path)):
        return len(query_pairs) == 1
    if _TASK_MESSAGE_EVENTS.fullmatch(path) or _CHAT_MESSAGE_EVENTS.fullmatch(path):
        return all(key in ("project_id", "cursor", "limit")
                   for key, _ in query_pairs)
    if path == "/api/workflow/list" or _WORKFLOW_DETAIL.fullmatch(path):
        return len(query_pairs) == 1
    if path == "/api/chat-sessions":
        return all(key in ("project_id", "workflow_id", "archived")
                   for key, _ in query_pairs)
    if _CHAT_SESSION_DETAIL.fullmatch(path):
        return len(query_pairs) == 1
    return False
