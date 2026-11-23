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


def test_evidence_fragments_keep_records_and_source_ids():
    import json
    from agent_assistants.archive_experience import _archive_evidence_fragments

    reviews = [{"id": f"review-{i}", "attempt": i, "report": '错误：' + '"\\\n' * 3000}
               for i in range(12)]
    evidence = {"existing_memory": "记忆规则\n" * 12000,
                "task": {"id": "task"}, "steps": [], "reviews": reviews,
                "messages": [{"id": "last-correction", "content": "再次缺失校验"}]}
    fragments = _archive_evidence_fragments(evidence)
    assert len(fragments) > 1
    units = []
    for fragment in fragments:
        assert len(fragment) <= 16000
        units.extend(json.loads(fragment))
    assert "".join(unit["text"] for unit in units
                   if unit["section"] == "existing_memory") == evidence["existing_memory"]
    for review in reviews:
        parts = [unit for unit in units if unit["section"] == "reviews"
                 and unit.get("source", {}).get("id") == review["id"] and unit.get("field") == "report"]
        assert "".join(part["text"] for part in parts) == review["report"]
        assert all(part["source"]["attempt"] == review["attempt"] for part in parts)
    assert units[-1]["record"]["id"] == "last-correction"


@pytest.mark.anyio
@pytest.mark.parametrize("invalid", ["", "笔记" * 5000], ids=["empty", "oversized"])
async def test_archive_recovers_invalid_notes_once(api_context, monkeypatch, invalid):
    class NotesEngine(CoordinatorFakeEngine):
        calls = []

        async def spawn(self, prompt, cwd, **kwargs):
            type(self).calls.append(prompt)
            if "Archive evidence fragment" in prompt:
                import json
                assert isinstance(json.loads(prompt.split("Fragment data:\n", 1)[1]), list)
                assert len(prompt) < 26000
                reply = invalid if len(type(self).calls) == 1 else "来源 review-1：第一次纠正；review-2：再次纠正。"
            else:
                reply = "<experience>- 重复遗漏校验，提交前运行相关测试。</experience>"
            yield InternalEvent("agent_message_chunk", {"content": {"text": reply}})

    client, tmp_path = api_context
    monkeypatch.setitem(ENGINE_REGISTRY, "claude", NotesEngine)
    project_id, task_id = await _create_task(client, tmp_path)
    await client.put(f"/api/fs/memory?project_id={project_id}", json={"content": "规则" * 30000})
    response = await client.post(f"/api/task/{task_id}/archive-experience/prepare?project_id={project_id}")
    assert response.status_code == 200, response.text
    assert "previous notes were empty or too long" in NotesEngine.calls[1]
    assert (await client.get(f"/api/task/{task_id}?project_id={project_id}")).json()["archived"] is False
