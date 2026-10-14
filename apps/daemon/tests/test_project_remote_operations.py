"""Remote project changes, retention and owner-only audit viewing."""
import asyncio
import threading
import time
from datetime import timedelta
import pytest
from models import ProjectAuditEvent
from models.fields import utc_now
from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context

@pytest.mark.anyio
async def test_remote_upload_workflow_and_task_preserve_actor_and_object(api_context, monkeypatch):
    import main
    from services.config import config_store
    monkeypatch.setattr(config_store, "get_user_name", lambda: "Owner")
    client, root = api_context
    path=root/"remote-audit"; path.mkdir()
    pid=(await client.post("/api/project/init",json={"path":str(path)})).json()["id"]
    query={"project_id":pid}
    spare=await client.post("/api/workflow/create",params=query,json={"name":"Spare"})
    assert spare.status_code==200
    actor=ActorSnapshot("remote-user","Remote Alice","remote-device","Phone","remote",project_id=pid,access_level="edit",username="alice")
    with actor_context(actor):
        flow=await client.post("/api/workflow/create",params=query,json={"name":"RemoteFlow"})
        assert flow.status_code==200,flow.text
        task=await client.post("/api/task/create",params=query,json={"title":"RemoteTask","workflow_id":flow.json()["id"],"auto_start":False})
        assert task.status_code==200,task.text
        upload=await client.post("/api/fs/upload/file",params=query,json={"filename":"report.txt","data_url":"data:text/plain;base64,aGVsbG8="})
        assert upload.status_code==200,upload.text
        deleted=await client.delete(f"/api/workflow/{flow.json()['id']}",params=query)
        assert deleted.status_code==200,deleted.text
        assert (await client.get("/api/project-audit",params=query)).status_code==403
    result=await client.get("/api/project-audit",params={**query,"remote_only":True})
    assert result.status_code==200,result.text
    rows=result.json()["items"]
    actions={row["action"]:row for row in rows}
    assert {"file.upload","workflow.create","workflow.delete","task.create"}<=actions.keys()
    assert all(row["actor_id"]=="remote-user" and row["actor_name"]=="Remote Alice" for row in rows)
    assert actions["file.upload"]["metadata"]["file_name"]=="report.txt"
    assert actions["file.upload"]["metadata"]["file_size"]==5
    assert actions["task.create"]["metadata"]["object_name"]=="RemoteTask"
    assert actions["workflow.delete"]["metadata"]["object_name"]=="RemoteFlow"
    assert all(row["metadata"]["access_source"]=="remote_project" for row in rows)
    assert result.json()["retention_days"]==30
    assert "aGVsbG8" not in result.text and str(path) not in result.text
    local=await client.post("/api/fs/upload/file",params=query,json={"filename":"local.txt","data_url":"data:text/plain;base64,aGVsbG8="})
    assert local.status_code==200
    assert len((await client.get("/api/project-audit",params={**query,"remote_only":True})).json()["items"])==len(rows)

@pytest.mark.anyio
async def test_audit_retention_deletes_only_old_project_rows_in_batches(api_context):
    import main
    from services.project_audit import prune_project_audit
    client,root=api_context
    path=root/"audit-retention";path.mkdir()
    pid=(await client.post("/api/project/init",json={"path":str(path)})).json()["id"]
    now=utc_now()
    def seed(project):
        for index in range(5):
            ProjectAuditEvent.create(id=f"old-{index}",project_id=pid,action="task.create",result="succeeded",mode="local",actor_type="user",created_at=now-timedelta(days=31))
        ProjectAuditEvent.create(id="current",project_id=pid,action="task.create",result="succeeded",mode="local",actor_type="user",created_at=now-timedelta(days=29))
        ProjectAuditEvent.create(id="other",project_id="other",action="task.create",result="succeeded",mode="local",actor_type="user",created_at=now-timedelta(days=31))
        assert prune_project_audit(pid,now=now,batch_size=2)==2
        assert prune_project_audit(pid,now=now,batch_size=2)==2
        assert prune_project_audit(pid,now=now,batch_size=2)==1
        return {r.id for r in ProjectAuditEvent.select()}
    assert await main.project_manager.run_db(pid,seed)=={"current","other"}

@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["upload", "workflow", "retention"])
async def test_slow_audit_sql_keeps_health_responsive(api_context, monkeypatch, operation):
    import main
    from services.project_audit_retention import ProjectAuditRetention
    client, root = api_context
    path = root / "slow-audit"; path.mkdir()
    pid = (await client.post("/api/project/init", json={"path": str(path)})).json()["id"]
    project = main.project_manager.get_project_by_id(pid)
    entered = threading.Event()
    original = project.db.execute_sql
    def slow_sql(sql, *args, **kwargs):
        target = 'DELETE FROM "project_audit_events"' if operation == "retention" else 'INSERT INTO "project_audit_events"'
        if target in sql and not entered.is_set():
            entered.set(); time.sleep(0.7)
        return original(sql, *args, **kwargs)
    monkeypatch.setattr(project.db, "execute_sql", slow_sql)
    async def perform():
        if operation == "retention":
            await ProjectAuditRetention(main.project_manager).sweep()
            return
        actor = ActorSnapshot("alice", "Alice", "phone", "Phone", "remote")
        with actor_context(actor):
            if operation == "upload":
                response = await client.post("/api/fs/upload/file", params={"project_id": pid}, json={"filename": "report.txt", "data_url": "data:text/plain;base64,aGVsbG8="})
            else:
                response = await client.post("/api/workflow/create", params={"project_id": pid}, json={"name": "Flow"})
            assert response.status_code == 200, response.text
    pending = asyncio.create_task(perform())
    assert await asyncio.to_thread(entered.wait, 2)
    before = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - before < 0.5
    await pending

@pytest.mark.anyio
async def test_audit_failure_rolls_back_upload_and_workflow(api_context, monkeypatch):
    import main
    import services.project_audit as audit
    from models import Workflow
    client, root = api_context
    path = root / "audit-rollback"; path.mkdir()
    pid = (await client.post("/api/project/init", json={"path": str(path)})).json()["id"]
    project = main.project_manager.get_project_by_id(pid)
    def fail(**kwargs):
        raise RuntimeError("audit disk unavailable")
    monkeypatch.setattr(audit, "record_remote_project_audit", fail)
    with actor_context(ActorSnapshot("alice", "Alice", "phone", "Phone", "remote")):
        for endpoint, payload in [("/api/workflow/create", {"name": "Rollback"}), ("/api/fs/upload/file", {"filename": "report.txt", "data_url": "data:text/plain;base64,aGVsbG8="})]:
            with pytest.raises(Exception):
                await client.post(endpoint, params={"project_id": pid}, json=payload)
    assert await main.project_manager.run_db(pid, lambda _project: Workflow.select().count()) == 0
    assert project.workflows == []
    assert not list((path / ".workstep/uploads").glob("*"))

@pytest.mark.anyio
async def test_remote_browser_without_identity_cannot_read_owner_audit(api_context):
    from httpx import ASGITransport, AsyncClient
    import main
    client, root = api_context
    path = root / "remote-browser-audit"; path.mkdir()
    pid = (await client.post("/api/project/init", json={"path": str(path)})).json()["id"]
    async with AsyncClient(transport=ASGITransport(app=main.app, client=("192.0.2.5", 40000)), base_url="http://test") as remote:
        assert (await remote.get("/api/project-audit", params={"project_id": pid})).status_code in {401, 403}

@pytest.mark.anyio
async def test_gateway_bridge_task_creation_preserves_authenticated_identity(api_context, monkeypatch):
    import base64
    import json
    import main
    from services.gateway_client.bridge import ManagedHttpBridge
    from workstep_gateway_protocol import FrameType, ProxyFrame
    from tests.test_api_contracts import _create_test_workflow
    client, root = api_context
    path = root / "gateway-audit"; path.mkdir()
    pid = (await client.post("/api/project/init", json={"path": str(path)})).json()["id"]
    flow = await _create_test_workflow(client, pid)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    frames = []
    async def capture(frame): frames.append(frame)
    bridge = ManagedHttpBridge(main.app, "audit-create", {
        "method": "POST", "path": "/api/task/create", "query": f"project_id={pid}",
        "headers": [["content-type", "application/json"]], "user_id": "gateway-alice", "username": "alice",
        "project_id": pid, "access_level": "edit", "task_create": True,
    }, capture, "device-1")
    bridge.start_task()
    body = json.dumps({"title": "GatewayTask", "workflow_id": flow["id"], "auto_start": False}).encode()
    await bridge.feed(ProxyFrame(stream_id="audit-create", type=FrameType.http_request, payload={"phase": "body", "data": base64.b64encode(body).decode()}))
    await bridge.feed(ProxyFrame(stream_id="audit-create", type=FrameType.http_request, payload={"phase": "end"}))
    await asyncio.wait_for(bridge._task, 3)
    assert frames[0].payload["status"] == 200, frames
    from services.project_audit import list_project_audit
    rows = (await main.project_manager.run_db(pid, lambda _project: list_project_audit(pid, remote_only=True)))["items"]
    row = next(row for row in rows if row["action"] == "task.create")
    assert row["actor_id"] == "gateway-alice" and row["actor_username"] == "alice"
    assert row["metadata"] == {"access_source": "gateway", "object_name": "GatewayTask"}
