"""Assistant messages inherit the person whose action caused the model call."""

from models import Message, Task, init_db
from models.fields import utc_now
from services.messages import create_task_message
from services.remote_access import ActorSnapshot, actor_context
from services.task import TaskService
from streaming.bus import EventBus


def test_user_task_message_snapshots_current_actor_and_initiator(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    try:
        now = utc_now()
        task = Task.create(id="task-actor", title="署名", cwd=str(tmp_path),
                           created_at=now, updated_at=now)
        actor = ActorSnapshot(
            actor_id="user-2", user_name="Alice Display", device_id="device-2",
            device_name="电脑二", source="managed", username="alice",
        )
        with actor_context(actor):
            message = create_task_message(
                task=task, channel="execution", step_key="do", role="user",
                content="开始", position=0, created_at=now,
            )
        assert (message.author_id, message.author_username, message.author_name,
                message.author_type, message.initiated_by_user_id,
                message.initiated_by_username) == (
                    "user-2", "alice", "Alice Display", "user", "user-2", "alice",
                )
        history = TaskService(EventBus()).get_task_history(task.id)
        assert history[0]["author_type"] == "user"
        assert history[0]["author_username"] == "alice"
    finally:
        db.close()


def test_assistant_message_keeps_own_author_and_inherits_initiator(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    try:
        now = utc_now()
        task = Task.create(
            id="task-1",
            title="归属测试",
            cwd=str(tmp_path),
            creator_id="creator-1",
            creator_name="任务创建人",
            creator_device_id="device-1",
            creator_device_name="电脑一",
            created_at=now,
            updated_at=now,
        )
        first = create_task_message(
            task=task,
            channel="execution",
            step_key="requirements",
            role="assistant",
            content="自动执行",
            position=1,
            created_at=now,
        )
        assert (first.author_id, first.author_type, first.initiated_by_user_id,
                first.initiated_by_username) == (
                    "assistant", "assistant", "creator-1", "任务创建人",
                )

        create_task_message(
            task=task,
            channel="execution",
            step_key="frontend",
            role="user",
            content="@前端 调整实现",
            author_id="user-2",
            author_username="operator",
            author_name="操作人",
            author_device_id="device-2",
            author_device_name="电脑二",
            position=0,
            created_at=now,
        )
        reply = create_task_message(
            task=task,
            channel="execution",
            step_key="frontend",
            role="assistant",
            content="调整完成",
            position=1,
            created_at=now,
        )
        assert (
            reply.author_id,
            reply.author_type,
            reply.initiated_by_user_id,
            reply.initiated_by_username,
            reply.author_device_id,
            reply.author_device_name,
        ) == ("assistant", "assistant", "user-2", "operator", "device-2", "电脑二")
        assert Message.select().count() == 3
    finally:
        db.close()
