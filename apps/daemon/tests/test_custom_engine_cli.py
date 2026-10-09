import pytest
from cli import build_parser, dispatch


class Client:
    def __init__(self): self.calls = []
    async def call(self, operation, arguments):
        self.calls.append((operation, arguments))
        if operation == "workstep_custom_engine_operation":
            return {"id": "a" * 32, "status": "running"}
        if operation == "workstep_custom_engine_operation_get":
            return {"id": "a" * 32, "status": "completed", "result": {"ok": True, "checks": []}}
        return {"ok": True}


@pytest.mark.asyncio
async def test_validate_polls_shared_operation():
    client = Client()
    args = build_parser().parse_args(["engine", "validate", "/tmp/example", "--json"])
    assert (await dispatch(args, client))["ok"] is True
    assert client.calls[0][0] == "workstep_custom_engine_operation"
    assert client.calls[0][1]["action"] == "validate"
    assert client.calls[-1][0] == "workstep_custom_engine_operation_get"


@pytest.mark.asyncio
async def test_register_explicit_update_and_export():
    client = Client()
    await dispatch(build_parser().parse_args(["engine", "register", "/tmp/example", "--replace"]), client)
    assert client.calls[-1][1]["replace"] is True
    await dispatch(build_parser().parse_args(["engine", "export", "example", "--output", "/tmp/example.zip"]), client)
    assert client.calls[-1][0] == "workstep_custom_engine_export"
