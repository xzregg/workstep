import pytest
from workstep_gateway_protocol.project_scope import project_http_route_allowed


@pytest.mark.parametrize("level", ["read", "edit"])
@pytest.mark.parametrize("path", ["/api/language-packs", "/api/language-packs/contract", "/api/language-packs/spanish"])
def test_language_catalog_is_project_scoped(level, path):
    query = [("project_id", "shared")]
    def allowed(method, target, pairs):
        return project_http_route_allowed(method, target, pairs, "shared", access_level=level)
    assert allowed("GET", path, query)
    for pairs in ([], [("project_id", "private")], query + query, query + [("extra", "1")]):
        assert not allowed("GET", path, pairs)
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        assert not allowed(method, path, query)
    for suffix in ("validate", "register", "import", "export", "spanish/export", "../secret"):
        for method in ("GET", "POST", "DELETE"):
            assert not allowed(method, "/api/language-packs/" + suffix, query)
