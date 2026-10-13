import pytest
from cli import build_parser, dispatch
from services.tool_registry import TOOL_BY_NAME

class Client:
    def __init__(self): self.calls = []
    async def call(self, operation, arguments):
        self.calls.append((operation, arguments)); return {"ok": True}

@pytest.mark.asyncio
async def test_language_commands_share_rest_tools():
    client = Client()
    for argv, tool in [(["language", "list"], "workstep_language_list"), (["language", "contract"], "workstep_language_contract"), (["language", "validate", "/tmp/skin"], "workstep_language_validate"), (["language", "register", "/tmp/skin", "--replace"], "workstep_language_register"), (["language", "export", "ocean", "--output", "/tmp/ocean.zip"], "workstep_language_export"), (["language", "delete", "ocean"], "workstep_language_delete")]:
        await dispatch(build_parser().parse_args(argv), client)
        assert client.calls[-1][0] == tool
        assert TOOL_BY_NAME[tool].path.startswith("/api/language-packs")
    assert client.calls[3][1]["replace"] is True
