import ast
from pathlib import Path


def test_gateway_has_api_service_and_model_layers():
    root = Path(__file__).parents[1] / "src/gateway"
    for layer in ("api", "services", "models"):
        assert (root / layer / "__init__.py").is_file()
    for file in (root / "services").glob("*.py"):
        for node in ast.walk(ast.parse(file.read_text())):
            if isinstance(node, ast.ImportFrom):
                assert not (node.module or "").startswith("gateway.api"), file
    assert (root.parent.parent / "main.py").is_file()
    assert (root.parents[3] / "start-gateway.sh").is_file()


def test_identity_core_does_not_depend_on_http_framework():
    path = Path(__file__).parents[1] / "src/gateway/services/identity.py"
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.ImportFrom):
            assert not (node.module or "").startswith(("fastapi", "starlette", "gateway.api")), path


def test_all_services_are_independent_of_http_framework():
    root = Path(__file__).parents[1] / "src/gateway/services"
    violations = []
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith(("fastapi", "starlette", "gateway.api")):
                violations.append(f"{path.name}:{node.lineno}: {node.module}")
            if isinstance(node, ast.Import) and any(item.name.startswith(("fastapi", "starlette", "gateway.api")) for item in node.names):
                violations.append(f"{path.name}:{node.lineno}: HTTP framework import")
            if isinstance(node, ast.Attribute) and node.attr == "app":
                violations.append(f"{path.name}:{node.lineno}: request.app")
    assert not violations, "\n".join(violations)


def test_api_adapters_do_not_own_database_queries():
    root = Path(__file__).parents[1] / "src/gateway/api"
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom):
                assert not (node.module or "").startswith(("gateway.models", "sqlalchemy")), path
            if isinstance(node, ast.Import):
                assert not any(item.name.startswith(("gateway.models", "sqlalchemy")) for item in node.names), path
