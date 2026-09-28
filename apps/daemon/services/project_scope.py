"""Allowlisted API surface for a Gateway session bound to one local project."""

from starlette.requests import Request
from workstep_gateway_protocol import project_http_route_allowed


def project_http_allowed(request: Request, project_id: str, access_level: str,
                         task_create: bool = False) -> bool:
    if access_level not in ("read", "edit"):
        return False
    return project_http_route_allowed(request.method, request.url.path,
                                      list(request.query_params.multi_items()),
                                      project_id, access_level=access_level,
                                      task_create=task_create)
