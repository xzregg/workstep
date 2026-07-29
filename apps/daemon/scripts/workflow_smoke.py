"""Exercise a one-step workflow through the production runtime and real LLM."""

import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import services.project as project_service
from engines.registry import refresh_registry
from models import Message, Task
from services.project import ProjectManager
from services.task import TaskService
from services.workflow_runtime import WorkflowRuntime
from streaming.bus import EventBus


class MemoryConfigStore:
    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


async def main() -> int:
    project_service.config_store = MemoryConfigStore()
    refresh_registry()
    bus = EventBus()
    manager = ProjectManager()
    runtime = WorkflowRuntime(bus, manager)

    with tempfile.TemporaryDirectory(prefix="workstep-workflow-smoke-") as tmp:
        project = manager.init_project(Path(tmp), name="Workflow smoke")
        project.steps = {
            "nodes": [
                {
                    "id": "smoke",
                    "type": "smoke",
                    "title": "Smoke",
                    "engine": "claude",
                    "prompt": "Reply exactly WORKSTEP_WORKFLOW_OK. Do not use tools.",
                    "inputs": [],
                    "outputs": [],
                }
            ],
            "connections": [],
        }
        service = TaskService(bus)
        task = service.create_task(
            title="Real workflow smoke",
            cwd=tmp,
            engine="claude",
            workflow=project.steps,
        )
        queue = bus.subscribe()
        handle = await runtime.start(project.id, task["id"], "")
        await asyncio.wait_for(runtime.wait(handle), timeout=120)

        events = []
        while not queue.empty():
            events.append(await queue.get())
        bus.unsubscribe(queue)

        with manager.activate_project_by_id(project.id):
            persisted_task = Task.get_by_id(task["id"])
            messages = list(Message.select().where(Message.task == task["id"]))
            text = "".join(message.content for message in messages)

        result = {
            "status": "passed"
            if persisted_task.status == "ready"
            and "WORKSTEP_WORKFLOW_OK" in text
            else "failed",
            "task_status": persisted_task.status,
            "messages": len(messages),
            "event_types": [event["type"] for event in events],
            "text": text,
        }
        print(json.dumps(result, ensure_ascii=False))

    await runtime.shutdown()
    await bus.close()
    manager.close_all()
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
