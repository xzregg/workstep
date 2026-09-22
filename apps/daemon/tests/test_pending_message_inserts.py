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
