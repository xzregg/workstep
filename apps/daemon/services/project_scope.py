"""Allowlisted API surface for a Gateway session bound to one local project."""

from starlette.requests import Request


def project_http_allowed(request: Request, project_id: str, access_level: str) -> bool:
    if access_level not in ("read", "edit"):
        return False
    if request.method != "GET":
        return False
    if request.url.path == f"/api/project/{project_id}/summary":
        return not request.query_params
    if request.url.path != "/api/task/list":
        return False
    values = request.query_params.getlist("project_id")
    return len(values) == 1 and values[0] == project_id
