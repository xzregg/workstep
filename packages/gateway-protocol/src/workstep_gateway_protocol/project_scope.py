"""Shared, deny-by-default route map for one published project."""

import re


_TASK_DETAIL = re.compile(r"/api/task/[A-Za-z0-9_-]{1,128}\Z")
_TASK_READ_DETAIL = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/"
    r"(?:execution-report|history|artifacts|reviews|coordinator-config)\Z")
_TASK_STEP_CONFIG = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/step/[A-Za-z0-9_-]{1,128}/config\Z")
_TASK_STEP_ACTION = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/step/[A-Za-z0-9_-]{1,128}/"
    r"(?:cancel|resume|restart)\Z")
_TASK_MESSAGE_ACTION = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/messages/[A-Za-z0-9_-]{1,128}/"
    r"(?:retry|set-complete)\Z")
_TASK_COORDINATOR_STOP = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/coordinator/stop\Z")
_TASK_PROPOSAL_ACTION = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/actions/[A-Za-z0-9_-]{1,128}/"
    r"(?:confirm|cancel)\Z")
_TASK_REVIEW_DECISION = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/steps/[A-Za-z0-9_-]{1,128}/review/"
    r"(?:approve|reject|force-approve|terminate|complete-task|set-complete)\Z")
_TASK_ARCHIVE_EXPERIENCE = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/archive-experience/"
    r"(draft|prepare|stop|confirm)\Z")
_SAFE_MESSAGE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_TASK_METADATA_UPDATE = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/(?:scheduled-start|coordinator-config)\Z")
_TASK_STEP_HISTORY = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/step/[A-Za-z0-9_-]{1,128}/history\Z")
_TASK_MESSAGE_EVENTS = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/messages/[A-Za-z0-9_-]{1,128}/events\Z")
_TASK_CHAT = re.compile(r"/api/task/[A-Za-z0-9_-]{1,128}/chat\Z")
_TASK_STEP_MESSAGE = re.compile(
    r"/api/task/[A-Za-z0-9_-]{1,128}/step/[A-Za-z0-9_-]{1,128}/message\Z")
_WORKFLOW_DETAIL = re.compile(r"/api/workflow/[A-Za-z0-9_-]{1,128}\Z")
_WORKFLOW_ACTION = re.compile(
    r"/api/workflow/[A-Za-z0-9_-]{1,128}/(?:actions|restore)\Z")
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
_CHAT_SESSION_TRANSITION = re.compile(
    r"/api/chat-sessions/[A-Za-z0-9_-]{1,128}/(?:fork|handoff)\Z")
_UPLOAD_FILE = re.compile(r"/api/fs/serve/[A-Za-z0-9_.-]{1,256}\Z")
_PROJECT_RAW = re.compile(r"/api/fs/project-raw/[A-Za-z0-9_-]{1,128}/.+\Z")


def project_http_route_allowed(method: str, path: str,
                               query_pairs: list[tuple[str, str]],
                               project_id: str, *, access_level: str = "read",
                               task_create: bool = False) -> bool:
    if not project_id or access_level not in ("read", "edit"):
        return False
    if method in ("POST", "PUT", "PATCH", "DELETE"):
        if access_level != "edit":
            return False
        archive_action = _TASK_ARCHIVE_EXPERIENCE.fullmatch(path)
        if method == "POST" and archive_action and archive_action.group(1) in ("prepare", "stop"):
            if query_pairs == [("project_id", project_id)]:
                return archive_action.group(1) == "prepare"
            if len(query_pairs) != 2:
                return False
            params = dict(query_pairs)
            return (len(params) == 2 and params.get("project_id") == project_id
                    and _SAFE_MESSAGE_ID.fullmatch(params.get("message_id", "")) is not None)
        if query_pairs != [("project_id", project_id)]:
            return False
        if method == "PUT":
            if _WORKFLOW_DETAIL.fullmatch(path):
                return True
            return path in (
                "/api/fs/content", "/api/chat-sessions/quick-buttons",
                "/api/chat-sessions/system-prompt",
            )
        if method == "PATCH":
            if (_TASK_DETAIL.fullmatch(path) or _TASK_METADATA_UPDATE.fullmatch(path)
                    or _TASK_STEP_CONFIG.fullmatch(path)):
                return True
            if _CHAT_SESSION_DETAIL.fullmatch(path) or _CHAT_SESSION_UPDATE.fullmatch(path):
                return True
            return path == "/api/fs/entry"
        if method == "DELETE":
            if path == "/api/task/delete":
                return True
            if _TASK_STEP_CONFIG.fullmatch(path):
                return True
            if _WORKFLOW_DETAIL.fullmatch(path):
                return True
            if _CHAT_SESSION_DETAIL.fullmatch(path):
                return True
            return path == "/api/fs/entry"
        if path == "/api/task/create":
            return task_create
        if path == "/api/task/copy":
            return task_create
        if path in ("/api/task/archive", "/api/task/unarchive"):
            return True
        if archive_action and archive_action.group(1) == "confirm":
            return True
        if path in ("/api/workflow/create", "/api/workflow/reorder"):
            return True
        if _WORKFLOW_ACTION.fullmatch(path):
            return True
        if path == "/api/chat-sessions" or _CHAT_SESSION_CHAT.fullmatch(path):
            return True
        if path in ("/api/chat-sessions/reorder", "/api/chat-sessions/bulk-delete"):
            return True
        if path == "/api/chat-sessions/enhance-prompt":
            return True
        if _CHAT_SESSION_ACTION.fullmatch(path) or _CHAT_SESSION_TRANSITION.fullmatch(path):
            return True
        if path in ("/api/fs/upload/file", "/api/fs/upload/image", "/api/fs/entry"):
            return True
        if _TASK_CHAT.fullmatch(path) or _TASK_STEP_MESSAGE.fullmatch(path):
            return True
        if (_TASK_COORDINATOR_STOP.fullmatch(path) or _TASK_STEP_ACTION.fullmatch(path)
                or _TASK_MESSAGE_ACTION.fullmatch(path)
                or _TASK_PROPOSAL_ACTION.fullmatch(path)
                or _TASK_REVIEW_DECISION.fullmatch(path)):
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
    if path == "/api/statistics/overview":
        return all(key in ("project_id", "workflow_id", "range", "start", "end", "timezone")
                   for key, _ in query_pairs)
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
    if _UPLOAD_FILE.fullmatch(path):
        return len(query_pairs) == 1
    if path == "/api/task/list":
        return all(key in ("project_id", "workflow_id", "archived")
                   for key, _ in query_pairs)
    if _TASK_DETAIL.fullmatch(path):
        return len(query_pairs) == 1
    archive_action = _TASK_ARCHIVE_EXPERIENCE.fullmatch(path)
    if archive_action and archive_action.group(1) == "draft":
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
    if path in ("/api/chat-sessions/quick-buttons", "/api/chat-sessions/system-prompt"):
        return len(query_pairs) == 1
    if _CHAT_SESSION_DETAIL.fullmatch(path):
        return len(query_pairs) == 1
    return False
