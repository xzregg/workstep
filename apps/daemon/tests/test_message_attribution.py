"""Assistant messages inherit the person whose action caused the model call."""

from models import Message, Task, init_db
from models.fields import utc_now
from services.messages import create_task_message


def test_assistant_message_inherits_latest_message_actor_and_falls_back_to_creator(tmp_path):
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
        assert (first.author_id, first.author_name) == ("creator-1", "任务创建人")

        create_task_message(
            task=task,
            channel="execution",
            step_key="frontend",
            role="user",
            content="@前端 调整实现",
            author_id="user-2",
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
            reply.author_name,
            reply.author_device_id,
            reply.author_device_name,
        ) == ("user-2", "操作人", "device-2", "电脑二")
        assert Message.select().count() == 3
    finally:
        db.close()
