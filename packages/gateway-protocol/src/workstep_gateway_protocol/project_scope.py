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
_WORKFLOW_HOOKS = re.compile(r"/api/workflow/[A-Za-z0-9_-]{1,128}/hooks\Z")
_NOTIFICATION_HOOKS = re.compile(r"/api/workflow/[A-Za-z0-9_-]{1,128}/notification-hooks\Z")
_NOTIFICATION_HISTORY = re.compile(r"/api/workflow/[A-Za-z0-9_-]{1,128}/notification-hooks/[A-Za-z0-9_-]{1,128}/deliveries\Z")
_NOTIFICATION_ACTION = re.compile(r"/api/workflow/[A-Za-z0-9_-]{1,128}/notification-hooks/(?:preview|[A-Za-z0-9_-]{1,128}/test|[A-Za-z0-9_-]{1,128}/deliveries/[A-Za-z0-9_-]{1,128}/retry)\Z")
_WORKFLOW_STEP_PROMPT = re.compile(
    r"/api/workflow/[A-Za-z0-9_-]{1,128}/step/[A-Za-z0-9_-]{1,128}/prompt\Z")
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
_SESSION_ACTION_CATALOG = re.compile(r"/api/project-actions/sessions/[A-Za-z0-9_-]{1,128}\Z")
_SESSION_ACTION_RUN = re.compile(r"/api/project-actions/sessions/[A-Za-z0-9_-]{1,128}/run\Z")
_TASK_HISTORY = re.compile(r"/api/task/[A-Za-z0-9_-]{1,128}/history\Z")
_UPLOAD_FILE = re.compile(r"/api/fs/serve/[A-Za-z0-9_.-]{1,256}\Z")
_PROJECT_RAW = re.compile(r"/api/fs/project-raw/[A-Za-z0-9_-]{1,128}/.+\Z")
_ENGINE_MODELS = re.compile(r"/api/engine/[A-Za-z0-9_-]{1,128}/models\Z")
_WORKSPACE_ASSET = re.compile(
    r"/(?:assets|static)/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:js|css|svg|png|jpe?g|webp|gif|ico|woff2?|ttf)\Z")


# Project workspace services share the same project identity; route-specific
# resource ownership is checked by their existing project/database handlers.
_PROJECT_SERVICES = [
    (r"/api/skills", {'GET'}, set()),
    (r"/api/skills/rescan", {'POST'}, set()),
    (r"/api/fs/memory", {'GET','PUT'}, set()),
    (r"/api/task/[A-Za-z0-9_-]{1,128}/discussion-groups", {'GET','POST'}, set()),
    (r"/api/task/[A-Za-z0-9_-]{1,128}/discussion-groups/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,256}", {'DELETE'}, set()),
    (r"/api/templates/(?:list|[A-Za-z0-9_-]{1,64})", {'GET'}, set()),
    (r"/api/tasks/[A-Za-z0-9_-]{1,128}/actions", {'GET'}, {'step_key'}),
    (r"/api/tasks/[A-Za-z0-9_-]{1,128}/actions/run", {'POST'}, set()),
    (r"/api/action-runs/[A-Za-z0-9_-]{1,128}", {'GET'}, set()),
    (r"/api/action-runs/[A-Za-z0-9_-]{1,128}/stop", {'POST'}, set()),
    (r"/api/workflow/generate/chat", {'POST'}, set()),
    (r"/api/workflow/generate/history", {'GET', 'DELETE'}, {'workflow_id'}),
    (r"/api/workflow/generate/history/messages/[A-Za-z0-9_-]{1,128}/events", {'GET'}, {'workflow_id','cursor','limit'}),
    (r"/api/workflow/generate/[A-Za-z0-9_-]{1,128}/stop", {'POST'}, set()),
    (r"/api/task-draft/chat", {'POST'}, set()),
    (r"/api/task-draft/[A-Za-z0-9_-]{1,128}/stop", {'POST'}, set()),
    (r"/api/project/save-steps", {'POST'}, {'workflow_id'}),
    (r"/api/schedule/list", {'GET'}, set()),
    (r"/api/schedule/(?:create|preview)", {'POST'}, set()),
    (r"/api/schedule/[A-Za-z0-9_-]{1,128}", {'GET','PATCH','DELETE'}, set()),
    (r"/api/schedule/[A-Za-z0-9_-]{1,128}/(?:pause|resume)", {'POST'}, set()),
    (r"/api/schedule/[A-Za-z0-9_-]{1,128}/runs", {'GET'}, {'limit','offset'}),
    (r"/api/pending-message-inserts", {'GET','POST','DELETE'}, {'target_message_id'}),
    (r"/api/pending-message-inserts/reorder", {'PUT'}, set()),
    (r"/api/pending-message-inserts/[A-Za-z0-9_-]{1,128}", {'PATCH','DELETE'}, set()),
    (r"/api/git/worktrees/[A-Za-z0-9_-]{1,128}/(?:status|branches|remotes|identity|history|changes|diff|blame|recoveries)", {'GET'}, {'ref','offset','commit','path'}),
    (r"/api/git/worktrees/[A-Za-z0-9_-]{1,128}/(?:delete|branches|branches/delete|commit|discard|ignore|files/content|commit-message|fetch|fetch-remote|push|pull|switch|advance|merge|merge-into|recovery/preview|recovery/apply|push-branch)", {'POST'}, set()),
    (r"/api/git/worktrees/[A-Za-z0-9_-]{1,128}/identity", {'PUT'}, set()),
]
_PROJECT_SERVICES = [(re.compile(pattern + r"\Z"), methods, keys) for pattern, methods, keys in _PROJECT_SERVICES]


def _project_service_allowed(method, path, pairs, project_id, access_level):
    params = dict(pairs)
    if len(params) != len(pairs) or params.get('project_id') != project_id:
        return False
    if method != 'GET' and access_level != 'edit':
        return False
    for pattern, methods, keys in _PROJECT_SERVICES:
        if method in methods and pattern.fullmatch(path) and set(params) <= {'project_id', *keys}:
            return True
    # Resources with project identity in the path never accept another project.
    prefix = f'/api/git/projects/{project_id}/'
    if path.startswith(prefix):
        suffix = path[len(prefix):]
        if method == 'GET' and suffix == 'repositories':
            return set(params) <= {'project_id', 'refresh'}
        if re.fullmatch(r'tasks/[A-Za-z0-9_-]{1,128}/(?:workspace|worktrees(?:/[A-Za-z0-9_-]{1,128})?)', suffix):
            return method in ('GET','POST','DELETE') and set(params) <= {'project_id','force'}
        return method == 'POST' and suffix == 'initialize' and set(params) == {'project_id'}
    prefix = f'/api/projects/{project_id}/'
    if path.startswith(prefix):
        suffix = path[len(prefix):]
        if suffix in ('settings', 'settings/concurrency'):
            return method in ('GET','PUT') and set(params) <= {'project_id','with_share'} and params.get('with_share','false') == 'false'
        if re.fullmatch(r'actions/[A-Za-z0-9_-]{1,128}/directory', suffix):
            return method == 'POST' and set(params) <= {'project_id','workflow_id'}
        if suffix == 'actions':
            return method == 'POST' and set(params) == {'project_id'}
    prefix = f'/api/skills/projects/{project_id}'
    if path == prefix or path in (prefix + '/batch', prefix + '/rescan'):
        return method in ('GET','POST','PUT','PATCH') and set(params) == {'project_id'}
    return False


def project_http_route_allowed(method: str, path: str,
                               query_pairs: list[tuple[str, str]],
                               project_id: str, *, access_level: str = "read",
                               task_create: bool = False) -> bool:
    if not project_id or access_level not in ("read", "edit"):
        return False
    if _project_service_allowed(method, path, query_pairs, project_id, access_level):
        return True
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
            if _WORKFLOW_HOOKS.fullmatch(path) or _NOTIFICATION_HOOKS.fullmatch(path):
                return True
            if _WORKFLOW_DETAIL.fullmatch(path):
                return True
            return path in (
                "/api/fs/content", "/api/chat-sessions/quick-buttons",
                "/api/chat-sessions/system-prompt",
            )
        if method == "PATCH":
            if _WORKFLOW_STEP_PROMPT.fullmatch(path):
                return True
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
        if _NOTIFICATION_ACTION.fullmatch(path):
            return True
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
        if _SESSION_ACTION_RUN.fullmatch(path):
            return True
        if path == "/api/chat-sessions" or _CHAT_SESSION_CHAT.fullmatch(path):
            return True
        if path in ("/api/chat-sessions/reorder", "/api/chat-sessions/bulk-delete"):
            return True
        if path == "/api/chat-sessions/enhance-prompt":
            return True
        if _CHAT_SESSION_ACTION.fullmatch(path) or _CHAT_SESSION_TRANSITION.fullmatch(path):
            return True
        if path in ("/api/fs/upload/file", "/api/fs/upload/image", "/api/fs/entry", "/api/fs/browser-upload"):
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
    if path in ("/", "/tasks", "/chat", "/canvas", "/statistics", "/file-preview"):
        return True
    if path == "/favicon.svg" or (_WORKSPACE_ASSET.fullmatch(path)
            and not any(part in (".", "..") for part in path.split("/"))):
        return not query_pairs
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
    if _WORKFLOW_HOOKS.fullmatch(path):
        return access_level == 'edit' and len(query_pairs) == 1
    if _NOTIFICATION_HOOKS.fullmatch(path) or _NOTIFICATION_HISTORY.fullmatch(path):
        return (access_level == 'edit' and len(query_pairs) == len(dict(query_pairs))
                and all(key in ({'project_id','offset'} if _NOTIFICATION_HISTORY.fullmatch(path) else {'project_id'}) for key,_ in query_pairs))
    if path in ("/api/engine/list", "/api/engine/execution/config",
                "/api/engine/coordinator/config", "/api/assistant/list", "/api/provider/list"):
        return len(query_pairs) == 1
    if _ENGINE_MODELS.fullmatch(path):
        return all(key in ("project_id", "provider_id") for key, _ in query_pairs) and len(query_pairs) == len(dict(query_pairs))
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
    if _TASK_HISTORY.fullmatch(path):
        return (all(key in ("project_id", "limit", "offset") for key, _ in query_pairs)
                and len(query_pairs) == len(dict(query_pairs)))
    if _SESSION_ACTION_CATALOG.fullmatch(path):
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
        return (all(key in ("project_id", "limit", "offset") for key, _ in query_pairs)
                and len(query_pairs) == len(dict(query_pairs)))
    return False
