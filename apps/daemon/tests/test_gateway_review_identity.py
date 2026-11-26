"""Gateway review identity survives native browser access and history reloads."""
from types import SimpleNamespace
from urllib.parse import quote

import pytest
from httpx import ASGITransport, AsyncClient

from services.gateway_client.identity import ManagedActor, ManagedLocalSessions
from tests.test_api_contracts import api_context  # noqa: F401
from tests.test_task_workflow_execution import scenario, node  # noqa: F401
from tests.test_parallel_review_decisions import pending_review


@pytest.mark.anyio
@pytest.mark.parametrize("decision", ["approve", "reject"])
@pytest.mark.parametrize("identity", ["gateway", "unnamed", "session", "local", "lan", "desktop", "local-config"])
async def test_review_uses_authenticated_gateway_identity(scenario, monkeypatch, decision, identity):
    import main
    s = scenario
    def manual(flow):
        step = node("requirements", ["PRD"])
        step["review"] = {"mode": "manual"}
        flow.update(nodes=[step], connections=[])
    await s.source_update(manual)
    await s.start()
    review = await pending_review(s)
    sessions = ManagedLocalSessions()
    owner = ManagedActor("owner", "gateway-login", "gateway-device", "instance", 1,
                         display_name=None if identity == "unnamed" else "网关审核人")
    gateway = SimpleNamespace(managed_config=None if identity == "local" else object(),
                              current_actor=owner, local_sessions=sessions)
    monkeypatch.setattr(main.app.state, "gateway_client", gateway)
    monkeypatch.setattr(main.app.state, "remote_access_service",
                        SimpleNamespace(settings=lambda: {"enabled": True}))
    headers = {"X-WorkStep-Actor-Id": "local-browser", "X-WorkStep-Actor-Name": quote("本地姓名"),
               "X-WorkStep-Actor-Device-Id": "browser", "X-WorkStep-Actor-Device-Name": quote("本地浏览器")}
    expected_id, expected_name = "owner", "gateway-login" if identity == "unnamed" else "网关审核人"
    if identity == "session":
        headers["X-WorkStep-Local-Session"] = sessions.create(ManagedActor(
            "actual-reviewer", "reviewer-login", "review-device", "instance", 1,
            display_name="实际登录审核人"))
        expected_id, expected_name = "actual-reviewer", "实际登录审核人"
    elif identity == "desktop":
        monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
        monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "desktop-secret")
        headers["X-WorkStep-Desktop-Token"] = "desktop-secret"
    elif identity in {"local", "lan"}:
        expected_id, expected_name = "local-browser", "本地姓名"
    elif identity == "local-config":
        from services.config import config_store
        gateway.managed_config = None
        headers.clear()
        monkeypatch.setattr(config_store, "get_user_name", lambda: "本机配置姓名")
        monkeypatch.setattr(config_store, "get_device_identity", lambda: {
            "device_id": "local-device", "device_name": "本机设备",
        })
        expected_id, expected_name = "local-device", "本机配置姓名"
    # LAN native access retains the visitor profile and must not become the owner.
    if identity == "lan":
        monkeypatch.setattr(main.app.state.remote_access_service, "access_password_required", lambda: False, raising=False)
    peer = "192.168.1.20" if identity == "lan" else "127.0.0.1"
    async with AsyncClient(transport=ASGITransport(app=main.app, client=(peer, 1234)),
                           base_url="http://localhost", headers=headers) as client:
        response = await client.post(
            f"/api/task/{s.task_id}/steps/requirements/review/{decision}?project_id={s.pid}",
            json={"review_run_id": review.id, "comment": "原审核意见"})
        assert response.status_code == 200, response.text
        # Both the immediate reload and later entry read the persisted snapshot.
        headers["X-WorkStep-Actor-Name"] = quote("修改后的本地姓名")
        client.headers.update(headers)
        for _ in range(2):
            rows = (await client.get(f"/api/task/{s.task_id}/reviews?project_id={s.pid}")).json()["reviews"]
            saved = next(row for row in rows if row["id"] == review.id)
            assert (saved["reviewer_id"], saved["reviewer_name"]) == (expected_id, expected_name)
            assert saved["decision"] == decision
            assert saved["decision_comment"] == "原审核意见"
        history = (await client.get(f"/api/task/{s.task_id}/history?project_id={s.pid}&limit=300")).json()["messages"]
        assert any(m["channel"] == "review" and m.get("author_id") == expected_id
                   and m.get("author_name") == expected_name for m in history)
