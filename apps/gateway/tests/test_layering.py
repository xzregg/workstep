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
