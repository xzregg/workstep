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
_TASK_CHAT = re.compile(r"/api/task/[A-Za-z0-9_-]{1,128}/chat\Z")
_TASK_STEP_MESSAGE = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/step/[A-Za-z0-9_-]{1,128}/message\Z")
_WORKFLOW_DETAIL = re.compile(r"/api/workflow/[A-Za-z0-9_-]{1,128}\Z")
_CHAT_SESSION_DETAIL = re.compile(r"/api/chat-sessions/[A-Za-z0-9_-]{1,128}\Z")
_CHAT_MESSAGE_EVENTS = re.compile(
    r"/api/chat-sessions/[A-Za-z0-9_-]{1,128}/messages/"
    r"[A-Za-z0-9_-]{1,128}/events\Z")
_CHAT_SESSION_CHAT = re.compile(
    r"/api/chat-sessions/[A-Za-z0-9_-]{1,128}/chat\Z")
_CHAT_SESSION_UPDATE = re.compile(
    r"/api/chat-sessions/[A-Za-z0-9_-]{1,128}/(?:archive|permission-mode)\Z")
_CHAT_SESSION_ACTION = re.compile(
    r"/api/chat-sessions/[A-Za-z0-9_-]{1,128}/(?:live-message|stop)\Z")
_UPLOAD_FILE = re.compile(r"/api/fs/serve/[A-Za-z0-9_.-]{1,256}\Z")
_PROJECT_RAW = re.compile(r"/api/fs/project-raw/[A-Za-z0-9_-]{1,128}/.+\Z")


def project_http_route_allowed(method: str, path: str,
                               query_pairs: list[tuple[str, str]],
                               project_id: str, *, access_level: str = "read",
                               task_create: bool = False) -> bool:
    if not project_id or access_level not in ("read", "edit"):
        return False
    if method in ("POST", "PUT", "PATCH", "DELETE"):
        if access_level != "edit" or query_pairs != [("project_id", project_id)]:
            return False
        if method == "PUT":
            return path == "/api/fs/content"
        if method == "PATCH":
            if _CHAT_SESSION_DETAIL.fullmatch(path) or _CHAT_SESSION_UPDATE.fullmatch(path):
                return True
            return path == "/api/fs/entry"
        if method == "DELETE":
            if _CHAT_SESSION_DETAIL.fullmatch(path):
                return True
            return path == "/api/fs/entry"
        if path == "/api/task/create":
            return task_create
        if path == "/api/chat-sessions" or _CHAT_SESSION_CHAT.fullmatch(path):
            return True
        if path in ("/api/chat-sessions/reorder", "/api/chat-sessions/bulk-delete"):
            return True
        if _CHAT_SESSION_ACTION.fullmatch(path):
            return True
        if path in ("/api/fs/upload/file", "/api/fs/upload/image", "/api/fs/entry"):
            return True
        if _TASK_CHAT.fullmatch(path) or _TASK_STEP_MESSAGE.fullmatch(path):
            return True
        return path in ("/api/task/run", "/api/task/pause", "/api/task/cancel")
    if method != "GET":
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
    if path == "/api/fs/browse":
        return all(key in ("project_id", "path", "include_hidden")
                   for key, _ in query_pairs)
    if path == "/api/fs/search":
        return all(key in ("project_id", "query", "root", "limit", "include_hidden")
                   for key, _ in query_pairs)
    if path == "/api/fs/file":
        return all(key in ("project_id", "path") for key, _ in query_pairs)
    if path == "/api/fs/preview" or _PROJECT_RAW.fullmatch(path):
        return all(key in ("project_id", "path", "absolute")
                   for key, _ in query_pairs) and all(
                       value in ("false", "False", "0") for key, value in query_pairs
                       if key == "absolute")
    if path.startswith("/api/fs/raw/") or _UPLOAD_FILE.fullmatch(path):
        return len(query_pairs) == 1
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
