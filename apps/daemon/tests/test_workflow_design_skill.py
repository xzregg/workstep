"""Bundled execution skill registration and public CLI execution contracts."""

import asyncio
import json
import re
import time
import threading
from pathlib import Path

import httpx
import pytest

from cli import build_parser, dispatch
from services.tool_registry import WorkstepClient


def test_builtin_skill_example_is_compatible_with_executor_and_canvas():
    from services.workflow_definition import WorkflowDefinition

    prompt = (Path(__file__).parents[1] / "data/skills/workstep-exec/SKILL.md").read_text()
    assert "name: workstep-exec" in prompt
    assert "# Workflow Mode" in prompt
    assert not re.search(r'[\u3400-\u9fff]', prompt)
    assert "Respond in the user's language" in prompt
    assert "Localize all user-facing text" in prompt
    example = re.search(r'```json\n\s*(\{.*\})\n', prompt).group(1)
    definition = json.loads(example)
    compiled = WorkflowDefinition.load(definition).compile().to_steps_config()
    assert compiled['steps'][1]['dependsOn'] == ['investigate']
    assert all(isinstance(node['id'], int) and node['id'] > 0 for node in definition['nodes'])
    assert all(node['type'] and isinstance(node['position']['x'], (int, float)) for node in definition['nodes'])


@pytest.mark.anyio
@pytest.mark.parametrize('engine_name,prefix', [('codex', '$'), ('codex_sdk', '$'), ('claude', '/workstep:'), ('claude_agent_sdk', '/workstep:')])
async def test_execution_skill_is_enabled_and_engine_supplies_invocation(tmp_path, monkeypatch, engine_name, prefix):
    import services.skill_center as module
    from engines.codex import CodexEngine
    from engines.codex_sdk import CodexSDKEngine
    from engines.claude_code import ClaudeCodeEngine
    from engines.claude_agent_sdk import ClaudeAgentSDKEngine
    from engines.core.base import BaseLLMEngine

    center = module.SkillCenter(source_roots={'builtin': module.BUILTIN_SKILLS_DIR})
    monkeypatch.setattr(module, 'skill_center', center)
    project = tmp_path / 'project'
    project.mkdir()
    engine = {'codex': CodexEngine, 'codex_sdk': CodexSDKEngine, 'claude': ClaudeCodeEngine, 'claude_agent_sdk': ClaudeAgentSDKEngine}[engine_name]()
    result = await BaseLLMEngine.inspect_capabilities(engine, str(project))
    item = next(item for item in result['input_items'] if item['name'] == 'workstep-exec')
    assert item['kind'] == 'skill'
    assert item['insert_text'] == prefix + 'workstep-exec '
    skill = next(skill for skill in result['skills'] if skill['name'] == 'workstep-exec')
    assert 'task_detail_url' in Path(skill['source_dir'], 'SKILL.md').read_text()
    descriptor = next(s for s in center.list_project(project) if s.name == 'workstep-exec')
    center.set_enabled(project, descriptor.skill_id, False)
    result = await BaseLLMEngine.inspect_capabilities(engine, str(project))
    assert not any(item['name'] == 'workstep-exec' for item in result['input_items'])


@pytest.mark.anyio
async def test_skill_cli_creates_workflow_then_task_then_starts_without_losing_task_link(tmp_path):
    steps = {'nodes': [{'id': 'build', 'key': 'build', 'title': '实现', 'prompt': '实现需求'}], 'connections': []}
    definition = tmp_path / 'flow.json'
    definition.write_text(json.dumps(steps))
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append((request.url.path, body))
        assert request.url.params['project_id'] == 'p1'
        if request.url.path == '/api/workflow/create':
            assert body == {'name': '实现流程', 'steps': steps}
            return httpx.Response(200, json={'id': 'w1', **body})
        if request.url.path == '/api/task/create':
            assert body['auto_start'] is False
            assert body['workflow_id'] == 'w1'
            return httpx.Response(200, json={'id': 't1', 'workflow_id': 'w1', 'status': 'pending'})
        assert request.url.path == '/api/task/run'
        assert body == {'task_id': 't1', 'prompt': ''}
        return httpx.Response(503, json={'detail': 'engine unavailable'})

    parser = build_parser()
    client = WorkstepClient(transport=httpx.MockTransport(handler))
    workflow = await dispatch(parser.parse_args(['workflow', 'create', '--project', 'p1', '--name', '实现流程', '--steps-file', str(definition)]), client)
    assert workflow['id'] == 'w1'
    task = await dispatch(parser.parse_args(['task', 'create', '--project', 'p1', '--workflow', 'w1', '--title', '实现需求', '--cwd', str(tmp_path), '--no-auto-start']), client)
    assert task['task_detail_url'] == 'workstep-task://open?project_id=p1&task_id=t1'
    started = await dispatch(parser.parse_args(['task', 'run', '--project', 'p1', '--task', task['id']]), client)
    assert started['ok'] is False
    assert task['id'] == 't1'  # Startup failure does not discard the created task.
    assert len(calls) == 3


@pytest.mark.anyio
async def test_workflow_cli_rejects_invalid_definition_without_request(tmp_path):
    path = tmp_path / 'bad.json'
    path.write_text('[]')
    calls = []
    client = WorkstepClient(transport=httpx.MockTransport(lambda req: calls.append(req)))
    args = build_parser().parse_args(['workflow', 'create', '--project', 'p1', '--name', '流程', '--steps-file', str(path)])
    with pytest.raises(ValueError, match='object'):
        await dispatch(args, client)
    assert calls == []


@pytest.mark.anyio
async def test_workflow_cli_slow_definition_read_keeps_event_loop_responsive(tmp_path, monkeypatch):
    definition = tmp_path / 'flow.json'
    definition.write_text('{"nodes":[],"connections":[]}')
    original = Path.read_text
    entered = threading.Event()

    def slow_read(path, *args, **kwargs):
        if path == definition:
            entered.set()
            time.sleep(.25)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'read_text', slow_read)
    client = WorkstepClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={'id': 'w1'})))
    args = build_parser().parse_args(['workflow', 'create', '--project', 'p', '--name', '流程', '--steps-file', str(definition)])
    pending = asyncio.create_task(dispatch(args, client))
    assert await asyncio.to_thread(entered.wait, 1)
    before = time.perf_counter()
    await asyncio.sleep(.01)
    assert time.perf_counter() - before < .15
    assert not pending.done()
    assert (await pending)['id'] == 'w1'


@pytest.mark.anyio
async def test_workflow_native_creation_requires_confirmation():
    result = await WorkstepClient().call('workstep_create_workflow', {
        'project_id': 'p1', 'name': '流程', 'steps': {'nodes': [], 'connections': []},
    })
    assert result['ok'] is False
    assert 'confirm' in result['error']
