"""Assistant messages inherit the person whose action caused the model call."""

from models import Message, Task, WorkflowRun, init_db
from models.fields import utc_now
from services.messages import create_task_message, current_actor_task_fields
from services.remote_access import ActorSnapshot, actor_context
from services.task import TaskService
from streaming.bus import EventBus
from datetime import timedelta
from types import SimpleNamespace


def test_scheduled_workflow_input_has_scheduler_author_and_creator_initiator(tmp_path):
    from services.workflow_start import prepare_start_in_project

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        now = utc_now()
        task = Task.create(
            id="scheduled-input", title="定时任务", cwd=str(tmp_path),
            creator_id="creator-1", creator_username="alice",
            creator_name="Alice", creator_device_id="device-1",
            creator_device_name="Laptop", created_at=now, updated_at=now,
        )
        project = SimpleNamespace(
            id="project-1", path=tmp_path,
            workstep_dir=tmp_path / ".workstep",
        )
        prepared = prepare_start_in_project(
            project, task.id, "定时启动文本", instance_id="daemon-1",
            current_workflow_steps=lambda _project, _task: {
                "nodes": [{"id": "do", "type": "do", "key": "do", "title": "执行"}],
                "connections": [],
            },
            source="schedule",
        )
        message = prepared.user_message
        assert message is not None
        assert (message.author_id, message.author_username, message.author_name,
                message.author_type) == (
                    "scheduler", "scheduler", "定时任务", "scheduler",
                )
        assert (message.initiated_by_user_id, message.initiated_by_username) == (
            "creator-1", "alice",
        )
        assert prepared.workflow_run.initiated_by_username == "alice"
        assert prepared.workflow_run.initiated_by_name == "Alice"
    finally:
        db.close()


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


def test_task_creator_username_is_preserved_for_automatic_reply(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    try:
        now = utc_now()
        actor = ActorSnapshot(
            actor_id="user-3", user_name="Bob Display", username="bob",
            device_id="device-3", device_name="电脑三", source="managed",
        )
        with actor_context(actor):
            task = Task.create(
                id="task-creator", title="自动回复", cwd=str(tmp_path),
                created_at=now, updated_at=now,
                **current_actor_task_fields(),
            )
        assert task.creator_name == "Bob Display"
        assert task.creator_username == "bob"
        reply = create_task_message(
            task=task, channel="execution", step_key="automatic",
            role="assistant", content="完成", position=1, created_at=now,
        )
        assert reply.initiated_by_user_id == "user-3"
        assert reply.initiated_by_username == "bob"
    finally:
        db.close()


def test_recovered_run_initiator_outweighs_previous_run_message(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    try:
        now = utc_now()
        task = Task.create(
            id="task-recovered", title="续跑", cwd=str(tmp_path),
            created_at=now, updated_at=now,
        )
        create_task_message(
            task=task, channel="execution", step_key="build", role="user",
            content="旧运行", author_id="old-user", author_username="old",
            author_name="Old Display", position=0,
            created_at=now - timedelta(minutes=1),
        )
        run = WorkflowRun.create(
            id="run-recovered", task=task, workflow_schema_version=1,
            status="running", started_at=now,
            initiated_by_user_id="new-user", initiated_by_username="new",
            initiated_by_name="New Display", initiated_by_device_id="device-new",
            initiated_by_device_name="New Device",
        )
        task.active_workflow_run_id = run.id
        task.save()
        reply = create_task_message(
            task=task, channel="execution", step_key="build",
            role="assistant", content="续跑完成", position=1,
            created_at=now + timedelta(seconds=1),
        )
        assert (reply.initiated_by_user_id, reply.initiated_by_username,
                reply.author_device_id) == (
                    "new-user", "new", "device-new",
                )
    finally:
        db.close()
