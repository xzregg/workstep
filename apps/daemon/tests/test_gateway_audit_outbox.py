"""Project audit outbox replays stable events after lost acknowledgments."""

import pytest
import asyncio
import json

from services.project import ProjectManager


@pytest.mark.anyio
async def test_gateway_audit_outbox_replays_and_marks_acknowledgments(tmp_path):
    from models import ProjectAuditEvent
    from services.gateway_client.audit_outbox import ProjectAuditOutbox
    from services.project_audit import record_project_audit

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    await manager.run_db(project.id, lambda _project: record_project_audit(
        project_id=project.id, task_id="task-1", action="task.start",
        result="succeeded", event_id="audit-1",
        metadata={"source": "manual"},
    ))
    outbox = ProjectAuditOutbox(manager)
    first = await outbox.pending(device_id="host-1")
    assert first is not None
    assert first["project_id"] == project.id
    assert first["events"] == [{
        "audit_event_id": "audit-1", "device_id": "host-1",
        "project_id": project.id, "task_id": "task-1",
        "action": "task.start", "result": "succeeded", "mode": "local",
        "actor_id": "system", "actor_username": "system",
        "actor_name": "system", "actor_type": "system",
        "actor_device_id": None, "actor_device_name": None,
        "initiated_by_user_id": None, "initiated_by_username": None,
        "metadata": {"source": "manual"},
        "occurred_at": first["events"][0]["occurred_at"],
    }]
    replay = await outbox.pending(device_id="host-1")
    assert replay["events"] == first["events"]
    await outbox.ack(project.id, first, accepted=["audit-1"],
                     duplicates=[], rejected=[])
    assert await outbox.pending(device_id="host-1") is None
    row = await manager.run_db(
        project.id, lambda _project: ProjectAuditEvent.get_by_id("audit-1"),
    )
    assert row.upload_status == "uploaded"
    assert row.uploaded_at is not None
    manager.close_all()


@pytest.mark.anyio
async def test_gateway_audit_outbox_quarantines_rejection(tmp_path):
    from models import ProjectAuditEvent
    from services.gateway_client.audit_outbox import ProjectAuditOutbox
    from services.project_audit import record_project_audit

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    await manager.run_db(project.id, lambda _project: record_project_audit(
        project_id=project.id, action="task.queue", result="succeeded",
        event_id="audit-rejected",
    ))
    outbox = ProjectAuditOutbox(manager)
    batch = await outbox.pending(device_id="host-1")
    await outbox.ack(project.id, batch, accepted=[], duplicates=[],
                     rejected=["audit-rejected"])
    assert await outbox.pending(device_id="host-1") is None
    row = await manager.run_db(
        project.id, lambda _project: ProjectAuditEvent.get_by_id("audit-rejected"),
    )
    assert row.upload_status == "rejected"
    assert row.upload_error == "gateway_rejected"
    manager.close_all()


@pytest.mark.anyio
async def test_control_audit_loop_waits_for_gateway_ack(tmp_path):
    from services.gateway_client.audit_outbox import ProjectAuditOutbox
    from services.gateway_client.control import GatewayControlClient
    from services.gateway_client.policy import ManagedPolicyCache
    from services.project_audit import record_project_audit

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    await manager.run_db(project.id, lambda _project: record_project_audit(
        project_id=project.id, action="task.start", result="succeeded",
        event_id="audit-control",
    ))
    outbox = ProjectAuditOutbox(manager)
    client = GatewayControlClient(
        "https://gateway.test", gateway_id="gateway-test",
        public_key_fingerprint="pin", user_id="user-1",
        policy_cache=ManagedPolicyCache(), audit_outbox=outbox,
    )
    messages = asyncio.Queue()
    sent = asyncio.Queue()

    class Socket:
        async def send(self, raw):
            await sent.put(json.loads(raw))

    task = asyncio.create_task(client._audit_loop(Socket(), "host-1", messages))
    batch = await asyncio.wait_for(sent.get(), timeout=1)
    assert batch["kind"] == "audit_batch"
    assert batch["events"][0]["audit_event_id"] == "audit-control"
    assert await outbox.pending(device_id="host-1") is not None
    messages.put_nowait({
        "kind": "audit_ack", "version": 1, "device_id": "host-1",
        "batch_id": batch["batch_id"], "accepted": ["audit-control"],
        "duplicates": [], "rejected": [],
    })
    for _ in range(20):
        if await outbox.pending(device_id="host-1") is None:
            break
        await asyncio.sleep(0.01)
    assert await outbox.pending(device_id="host-1") is None
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    manager.close_all()


@pytest.mark.anyio
async def test_control_reader_routes_audit_ack_to_upload_loop():
    from services.gateway_client.control import GatewayControlClient
    from services.gateway_client.policy import ManagedPolicyCache

    client = GatewayControlClient(
        "https://gateway.test", gateway_id="gateway-test",
        public_key_fingerprint="pin", user_id="user-1",
        policy_cache=ManagedPolicyCache(),
    )
    wire = asyncio.Queue()
    general, usage, skills, projects, audit = (asyncio.Queue() for _ in range(5))

    class Socket:
        async def recv(self):
            return await wire.get()

    reader = asyncio.create_task(client._read_control_messages(
        Socket(), "host-1", general, usage, skills, projects, audit,
    ))
    wire.put_nowait(json.dumps({"kind": "audit_ack", "version": 1,
                                "device_id": "host-1", "batch_id": "batch-1"}))
    routed = await asyncio.wait_for(audit.get(), timeout=1)
    assert routed["batch_id"] == "batch-1"
    assert general.empty() and usage.empty()
    reader.cancel()
    await asyncio.gather(reader, return_exceptions=True)
