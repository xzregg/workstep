"""Pending inserts stay outside formal history until a runtime consumes them."""

import pytest


def test_pending_insert_table_orders_merges_and_preserves_username(tmp_path):
    from models import init_db
    from services.pending_message_inserts import (
        create_pending_insert,
        list_pending_inserts,
        pending_insert_batch,
        reorder_pending_inserts,
    )

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        first = create_pending_insert("assistant-1", "第一条", "小王")
        second = create_pending_insert("assistant-1", "第二条", "小李")
        assert [item["id"] for item in list_pending_inserts("assistant-1")] == [
            first["id"],
            second["id"],
        ]

        reordered = reorder_pending_inserts(
            "assistant-1",
            [second["id"], first["id"]],
        )
        assert [item["content"] for item in reordered] == ["第二条", "第一条"]
        ids, content, username = pending_insert_batch("assistant-1")
        assert ids == [second["id"], first["id"]]
        assert content == "第二条\n\n第一条"
        assert username == "小李"
    finally:
        db.close()


def test_pending_insert_is_not_a_formal_message(tmp_path):
    from models import ChatMessage, Message, PendingMessageInsert, init_db
    from services.pending_message_inserts import create_pending_insert

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        created = create_pending_insert("assistant-1", "稍后处理", "用户甲")
        assert PendingMessageInsert.get_by_id(created["id"]).username == "用户甲"
        assert Message.select().count() == 0
        assert ChatMessage.select().count() == 0
    finally:
        db.close()


def test_pending_insert_preserves_distinct_actor_username(tmp_path):
    from models import PendingMessageInsert, init_db
    from services.pending_message_inserts import create_pending_insert
    from services.remote_access import ActorSnapshot, actor_context

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        actor = ActorSnapshot(
            actor_id="user-1", user_name="Alice Display", username="alice",
            device_id="device-1", device_name="Office PC", source="managed",
        )
        with actor_context(actor):
            created = create_pending_insert("assistant-1", "稍后处理", "Alice Display")
        row = PendingMessageInsert.get_by_id(created["id"])
        assert (row.author_id, row.author_username, row.author_name,
                row.author_device_id, row.author_device_name) == (
                    "user-1", "alice", "Alice Display", "device-1", "Office PC",
                )
    finally:
        db.close()


def test_legacy_pending_replay_does_not_adopt_current_actor(tmp_path):
    from models import PendingMessageInsert, init_db
    from models.fields import utc_now
    from services.pending_message_inserts import pending_insert_actor
    from services.remote_access import (
        ActorSnapshot, actor_context, get_effective_actor, replayed_actor_context,
    )

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        PendingMessageInsert.create(
            id="legacy", target_message_id="assistant-1", content="旧队列",
            position=0, username="Alice Display",
            created_at=utc_now(), updated_at=utc_now(),
        )
        assert pending_insert_actor("assistant-1") is None
        current = ActorSnapshot(
            actor_id="user-now", user_name="Alice Display", username="alice-now",
            device_id="device-now", device_name="Now", source="managed",
        )
        with actor_context(current):
            with replayed_actor_context(pending_insert_actor("assistant-1")):
                assert get_effective_actor() is None
            assert get_effective_actor() == current
    finally:
        db.close()


def test_oldest_task_pending_batch_selects_target_and_merges_in_position_order(tmp_path):
    from models import Message, Task, init_db
    from models.fields import utc_now
    from services.pending_message_inserts import (
        create_pending_insert,
        oldest_task_pending_batch,
        reorder_pending_inserts,
    )

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        now = utc_now()
        task = Task.create(
            id="task-pending", title="Pending", cwd=str(tmp_path),
            created_at=now, updated_at=now,
        )
        other = Task.create(
            id="task-other", title="Other", cwd=str(tmp_path),
            created_at=now, updated_at=now,
        )
        for message_id, owner, step_key in (
            ("later", task, "b"),
            ("first", task, "a"),
            ("foreign", other, "c"),
        ):
            Message.create(
                id=message_id, task=owner, step_key=step_key,
                role="assistant", position=0, created_at=now,
            )
        create_pending_insert("foreign", "别的任务", "其他用户")
        first = create_pending_insert("first", "第一条", "小王")
        second = create_pending_insert("first", "第二条", "小李")
        create_pending_insert("later", "稍后", "小张")
        reorder_pending_inserts("first", [second["id"], first["id"]])

        assert oldest_task_pending_batch(task.id) == (
            "a", [second["id"], first["id"]],
            "第二条\n\n第一条", "小李",
        )
        assert oldest_task_pending_batch("missing") is None
    finally:
        db.close()


@pytest.mark.anyio
async def test_task_pending_resume_restores_original_actor(tmp_path, monkeypatch):
    from models import Message, Task
    from models.fields import utc_now
    from services.pending_message_inserts import create_pending_insert
    from services.project import ProjectManager
    from services.remote_access import ActorSnapshot, actor_context, get_current_actor
    from services.workflow_runtime import WorkflowRuntime
    from streaming.bus import EventBus
    import services.project as project_service

    class MemoryConfigStore:
        def __init__(self):
            self.values = {}

        def get(self, key, default=None):
            return self.values.get(key, default)

        def set(self, key, value):
            self.values[key] = value

    monkeypatch.setattr(project_service, "config_store", MemoryConfigStore())
    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")

    def seed(_project):
        now = utc_now()
        task = Task.create(
            id="task-pending-actor", title="Pending", cwd=str(project.path),
            created_at=now, updated_at=now,
        )
        Message.create(
            id="reply-pending-actor", task=task, channel="execution",
            step_key="build", role="assistant", position=1, created_at=now,
        )

    await manager.run_db(project.id, seed)
    actor = ActorSnapshot(
        actor_id="user-1", user_name="Alice Display", username="alice",
        device_id="device-1", device_name="Office PC", source="managed",
    )
    with actor_context(actor):
        await manager.run_db(project.id, lambda _project: create_pending_insert(
            "reply-pending-actor", "继续", "Alice Display",
        ))

    bus = EventBus()
    runtime = WorkflowRuntime(bus, manager)
    observed = []

    async def fake_resume(project_id, task_id, step_key, content, **kwargs):
        observed.append((project_id, task_id, step_key, content,
                         kwargs["author_name"], get_current_actor()))

    monkeypatch.setattr(runtime, "resume_step_with_message", fake_resume)
    try:
        await runtime._consume_task_pending_inserts(project.id, "task-pending-actor")
        assert len(observed) == 1
        assert observed[0][:5] == (
            project.id, "task-pending-actor", "build", "继续", "Alice Display",
        )
        assert (observed[0][5].actor_id, observed[0][5].username) == (
            "user-1", "alice",
        )
    finally:
        await runtime.shutdown()
        await bus.close()
        manager.close_all()
