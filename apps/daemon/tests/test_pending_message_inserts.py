"""Pending inserts stay outside formal history until a runtime consumes them."""


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
