import pytest
from cli import build_parser, dispatch
from services.tool_registry import TOOL_BY_NAME

class Client:
    def __init__(self): self.calls = []
    async def call(self, operation, arguments):
        self.calls.append((operation, arguments)); return {"ok": True}

@pytest.mark.asyncio
async def test_skin_commands_share_rest_tools():
    client = Client()
    for argv, tool in [(["skin", "list"], "workstep_skin_list"), (["skin", "contract"], "workstep_skin_contract"), (["skin", "validate", "/tmp/skin"], "workstep_skin_validate"), (["skin", "register", "/tmp/skin", "--replace"], "workstep_skin_register"), (["skin", "export", "ocean", "--output", "/tmp/ocean.zip"], "workstep_skin_export"), (["skin", "delete", "ocean"], "workstep_skin_delete")]:
        await dispatch(build_parser().parse_args(argv), client)
        assert client.calls[-1][0] == tool
        assert TOOL_BY_NAME[tool].path.startswith("/api/skins")
    assert client.calls[3][1]["replace"] is True


@pytest.mark.asyncio
async def test_skill_draft_cli_uses_shared_host_tool_without_installing():
    client = Client()
    await dispatch(build_parser().parse_args(['skill', 'create', '--json']), client)
    assert client.calls == [('workstep_create_skill_draft', {'confirm': 'yes'})]
    assert TOOL_BY_NAME['workstep_create_skill_draft'].path == '/api/skills/onboarding'
