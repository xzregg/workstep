"""Persist the initiating user on workflow runs before background execution."""

from models import Task, WorkflowRun
from models.fields import utc_now
from services.project import ProjectManager
from services.remote_access import ActorSnapshot, actor_context
from services.workflow_start import prepare_start_in_project
from services.workflow_restart import create_restart_run


def test_workflow_run_snapshots_initiator_without_user_message(tmp_path, monkeypatch):
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
    workflow = {"nodes": [{
        "id": "stage-1", "type": "build", "title": "Build", "prompt": "Do it",
    }], "connections": []}
    now = utc_now()
    actor = ActorSnapshot(
        actor_id="user-1", user_name="Alice Display", username="alice",
        device_id="device-1", device_name="Office PC", source="managed",
    )
    with manager.activate_project(project.path):
        task = Task.create(
            id="task-attributed-run", title="Build", cwd=str(project.path),
            creator_id="creator-1", creator_username="creator",
            creator_name="Creator Display", created_at=now, updated_at=now,
        )
        with actor_context(actor):
            prepared = prepare_start_in_project(
                project, task.id, "", instance_id="daemon-1",
                current_workflow_steps=lambda _project, _task: workflow,
            )
        run = prepared.workflow_run
        assert prepared.user_message is None
        assert (run.initiated_by_user_id, run.initiated_by_username,
                run.initiated_by_name, run.initiated_by_device_id,
                run.initiated_by_device_name) == (
                    "user-1", "alice", "Alice Display", "device-1", "Office PC",
                )
    project.db.close()


def test_restart_run_inherits_initiator_or_snapshots_new_operator(tmp_path, monkeypatch):
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
    now = utc_now()
    with manager.activate_project(project.path):
        task = Task.create(
            id="task-restart", title="Restart", cwd=str(project.path),
            created_at=now, updated_at=now,
        )
        parent = WorkflowRun.create(
            id="run-parent", task=task, workflow_schema_version=1,
            status="running", started_at=now,
            initiated_by_user_id="user-1", initiated_by_username="alice",
            initiated_by_name="Alice Display",
            initiated_by_device_id="device-1",
            initiated_by_device_name="Office PC",
        )
        _, resumed = create_restart_run(
            task, parent, 1, "build", {"build"}, instance_id="daemon-2",
        )
        assert (resumed.initiated_by_user_id, resumed.initiated_by_username,
                resumed.initiated_by_name) == (
                    "user-1", "alice", "Alice Display",
                )
        operator = ActorSnapshot(
            actor_id="user-2", user_name="Bob Display", username="bob",
            device_id="device-2", device_name="Laptop", source="managed",
        )
        with actor_context(operator):
            _, restarted = create_restart_run(
                task, resumed, 1, "build", {"build"}, instance_id="daemon-2",
            )
        assert (restarted.initiated_by_user_id, restarted.initiated_by_username,
                restarted.initiated_by_name, restarted.initiated_by_device_id) == (
                    "user-2", "bob", "Bob Display", "device-2",
                )
    project.db.close()
