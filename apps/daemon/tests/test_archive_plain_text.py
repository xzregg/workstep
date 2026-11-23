"""Archive drafts use tagged text and expose output when validation fails."""

import pytest

import main
from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from tests.test_coordinator import CoordinatorFakeEngine, _create_task, api_context


@pytest.mark.anyio
@pytest.mark.parametrize("reply,expected", [
    ("<experience>\n- 金额统一使用分。\n</experience>", "- 金额统一使用分。"),
    ("标签外解释不能保存\n<experience>- 从 dev 创建分支。</experience>\n其他说明", "- 从 dev 创建分支。"),
    ("<experience>- " + "规" * 48 + "</experience>", "- " + "规" * 48),
    ("<no_experience />", ""),
    ("<no_experience/>", ""),
])
async def test_archive_accepts_and_streams_tagged_text(api_context, monkeypatch, reply, expected):
    class TextEngine(CoordinatorFakeEngine):
        calls = []

        async def spawn(self, prompt, cwd, **kwargs):
            type(self).calls.append(prompt)
            assert "Return JSON" not in prompt
            assert "<experience>" in prompt and "<no_experience />" in prompt
            for text in reply:
                yield InternalEvent("agent_message_chunk", {"content": {"text": text}})

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", TextEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    queue = main.coordinator_module._event_bus.subscribe()
    try:
        response = await client.post(
            f"/api/task/{task_id}/archive-experience/prepare?project_id={project_id}&message_id=text-draft",
        )
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())
    finally:
        main.coordinator_module._event_bus.unsubscribe(queue)
    assert response.status_code == 200, response.text
    assert response.json()["experience"] == expected
    assert response.json()["has_experience"] is bool(expected)
    assert len(TextEngine.calls) == 1
    assert "".join(event.get("delta", "") for event in events
                   if event["type"] == "TEXT_MESSAGE_CHUNK").strip() == expected
    draft = await client.get(f"/api/task/{task_id}/archive-experience/draft?project_id={project_id}")
    assert draft.json()["experience"] == expected
    assert (await client.get(f"/api/task/{task_id}?project_id={project_id}")).json()["archived"] is False
    assert (await client.get(f"/api/fs/memory?project_id={project_id}")).json()["content"] == ""
    confirmed = await client.post(
        f"/api/task/{task_id}/archive-experience/confirm?project_id={project_id}",
        json={"experience": response.json()["experience"]},
    )
    assert confirmed.json() == {"archived": True, "memory_saved": bool(expected)}
    memory = (await client.get(f"/api/fs/memory?project_id={project_id}")).json()["content"]
    if expected:
        assert expected in memory
    assert "<experience>" not in memory and "<no_experience" not in memory
    assert "标签外解释" not in memory and "其他说明" not in memory


@pytest.mark.anyio
async def test_archive_empty_output_does_not_become_no_experience_or_archive(api_context, monkeypatch):
    class EmptyEngine(CoordinatorFakeEngine):
        async def spawn(self, **kwargs):
            yield InternalEvent("agent_message_chunk", {"content": {"text": " "}})

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", EmptyEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    response = await client.post(f"/api/task/{task_id}/archive-experience/prepare?project_id={project_id}")
    assert response.status_code == 502
    assert "empty" in response.json()["detail"].lower()
    draft = await client.get(f"/api/task/{task_id}/archive-experience/draft?project_id={project_id}")
    assert draft.json()["found"] is False
    assert (await client.get(f"/api/task/{task_id}?project_id={project_id}")).json()["archived"] is False


@pytest.mark.anyio
@pytest.mark.parametrize("reply", [
    '- 金额使用分。', '{"reply":"- 金额使用分。"}',
    '<experience>- 金额使用分。', '<experience> </experience>',
    '<experience>- 金额使用分。</experience><no_experience />',
    '<experience>- 一条。</experience><experience>- 另一条。</experience>',
    '<no_experience /><no_experience />',
    '<no_experience>', '<no_experience /></experience>',
    '<experience>- ' + '长' * 60 + '</experience>',
])
async def test_archive_validation_failure_publishes_raw_output_without_saving(api_context, monkeypatch, reply):
    class InvalidEngine(CoordinatorFakeEngine):
        async def spawn(self, **kwargs):
            yield InternalEvent("agent_message_chunk", {"content": {"text": reply}})

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", InvalidEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    queue = main.coordinator_module._event_bus.subscribe()
    try:
        response = await client.post(f"/api/task/{task_id}/archive-experience/prepare?project_id={project_id}")
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())
    finally:
        main.coordinator_module._event_bus.unsubscribe(queue)
    assert response.status_code == 502
    assert any(event["type"] == "TEXT_MESSAGE_CONTENT" and event.get("content") == reply
               for event in events)
    assert any(event["type"] == "TEXT_MESSAGE_END" and event.get("status") == "failed"
               for event in events)
    draft = await client.get(f"/api/task/{task_id}/archive-experience/draft?project_id={project_id}")
    assert draft.json()["found"] is False
    assert (await client.get(f"/api/task/{task_id}?project_id={project_id}")).json()["archived"] is False
    assert (await client.get(f"/api/fs/memory?project_id={project_id}")).json()["content"] == ""


@pytest.mark.anyio
async def test_archive_starts_with_ids_and_reads_evidence_via_cli(api_context, monkeypatch):
    import httpx
    from cli import build_parser, dispatch
    from services.tool_registry import WorkstepClient
    from models import Message
    from models.fields import utc_now

    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)
    marker = "large-history-must-not-be-in-initial-prompt"
    project = main.project_manager.get_project_by_id(project_id)
    memory = "private-memory-rule" + "长记忆" * 20000
    await client.put(f"/api/fs/memory?project_id={project_id}", json={"content": memory})

    def history(_project):
        for index in range(24):
            Message.create(id=f"source-{index}", task=task_id, step_key="frontend", role="user",
                           channel="coordinator", sequence=1000 + index, position=index, created_at=utc_now(),
                           content=(marker + "长内容" * 2000 if index < 22 else "再次纠正：先按当前任务基线核对起点，再建分支"))
    await main.project_manager.run_db(project_id, history)

    class CliReadingEngine(CoordinatorFakeEngine):
        calls = []
        supports_workstep_tools = True

        async def spawn(self, prompt, cwd, **kwargs):
            type(self).calls.append(prompt)
            assert len(prompt) < 4000
            assert project_id in prompt and task_id in prompt
            assert marker not in prompt and "private-memory-rule" not in prompt
            assert "task history" in prompt and "task reviews" in prompt
            assert "Read the workstep-cli skill" in prompt
            assert "Do not execute tools" not in prompt
            assert kwargs.get("workstep_tools") is True
            assert str(project.workstep_dir / "MEMORY.md") in prompt
            native = WorkstepClient(base_url='http://test', transport=httpx.ASGITransport(app=main.app))
            parsed = build_parser().parse_args(['task','get','--project',project_id,'--task',task_id,'--json'])
            task = await dispatch(parsed, native)
            assert task['id'] == task_id
            ids = set()
            for offset in range(0, 40, 10):
                yield InternalEvent('tool_call', {'id': f'page-{offset}', 'title': 'task history', 'status': 'in_progress'})
                parsed = build_parser().parse_args(['task','history','--project',project_id,'--task',task_id,
                                                   '--limit','10','--offset',str(offset),'--json'])
                page = await dispatch(parsed, native)
                ids.update(row['id'] for row in page['messages'])
                if len(page['messages']) < 10:
                    break
            assert {'source-0','source-23'} <= ids
            parsed = build_parser().parse_args(['task','reviews','--project',project_id,'--task',task_id,'--json'])
            assert 'reviews' in await dispatch(parsed, native)
            yield InternalEvent('agent_message_chunk', {'content': {'text': '<no_experience />'}})

    monkeypatch.setitem(ENGINE_REGISTRY, "claude", CliReadingEngine)
    response = await client.post(f"/api/task/{task_id}/archive-experience/prepare?project_id={project_id}")
    assert response.status_code == 200, response.text
    assert len(CliReadingEngine.calls) == 1
    assert response.json()['has_experience'] is False
    assert (await client.get(f"/api/task/{task_id}?project_id={project_id}")).json()['archived'] is False
    assert (await client.get(f"/api/fs/memory?project_id={project_id}")).json()['content'] == memory


@pytest.mark.anyio
async def test_archive_checks_latest_memory_after_model_inspection(api_context, monkeypatch):
    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)
    rule = "- 分支开发前核对当前任务基线。"

    class MemoryUpdatedEngine(CoordinatorFakeEngine):
        async def spawn(self, **kwargs):
            response = await client.put(f"/api/fs/memory?project_id={project_id}", json={"content": rule})
            assert response.status_code == 200
            yield InternalEvent("agent_message_chunk", {"content": {"text": f"<experience>{rule}</experience>"}})

    monkeypatch.setitem(ENGINE_REGISTRY, "claude", MemoryUpdatedEngine)
    response = await client.post(f"/api/task/{task_id}/archive-experience/prepare?project_id={project_id}")
    assert response.status_code == 200, response.text
    assert response.json()["has_experience"] is False
    assert (await client.get(f"/api/fs/memory?project_id={project_id}")).json()["content"] == rule
