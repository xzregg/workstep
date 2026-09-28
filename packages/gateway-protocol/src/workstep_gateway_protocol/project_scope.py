"""Shared, deny-by-default route map for one published project."""

import re


_TASK_DETAIL = re.compile(r"/api/task/[A-Za-z0-9_-]{1,128}\Z")


def project_http_route_allowed(method: str, path: str,
                               query_pairs: list[tuple[str, str]],
                               project_id: str) -> bool:
    if method != "GET" or not project_id:
        return False
    if path == f"/api/project/{project_id}/summary":
        return not query_pairs
    values = [value for key, value in query_pairs if key == "project_id"]
    if values != [project_id]:
        return False
    if path == "/api/task/list":
        return all(key in ("project_id", "workflow_id", "archived")
                   for key, _ in query_pairs)
    if _TASK_DETAIL.fullmatch(path):
        return len(query_pairs) == 1
    return False
