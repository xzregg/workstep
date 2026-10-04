"""Device audit upload is bounded, idempotent, and scoped to its device."""

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import AuditEvent, Device, DirectoryDepartment, DirectoryMembership, DirectoryPerson, IdentitySource, PlatformProject
from gateway.services.audit_ledger import record_audit_batch


def _event(event_id="audit-1"):
    return {
        "audit_event_id": event_id, "device_id": "device-1",
        "project_id": "project-1", "task_id": "task-1",
        "action": "task.start", "result": "succeeded", "mode": "managed",
        "actor_id": "user-1", "actor_username": "alice",
        "actor_name": "Alice", "actor_type": "user",
        "actor_device_id": "browser-1", "actor_device_name": "Chrome",
        "initiated_by_user_id": "user-1", "initiated_by_username": "alice",
        "metadata": {"source": "manual"},
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }


def test_audit_batch_replay_and_conflicting_id(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
        })

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(
                        id="device-1", name="PC", public_key="test",
                        app_instance_id="app", version="1.0", status="active",
                    ))

        client.portal.call(seed)
        event = _event()
        first = client.portal.call(
            record_audit_batch, app.state.database, "device-1", "batch-1",
            [event],
        )
        assert first == {"batch_id": "batch-1", "accepted": ["audit-1"],
                         "duplicates": [], "rejected": []}
        replay = client.portal.call(
            record_audit_batch, app.state.database, "device-1", "batch-2",
            [event],
        )
        assert replay["duplicates"] == ["audit-1"]
        changed = client.portal.call(
            record_audit_batch, app.state.database, "device-1", "batch-3",
            [{**event, "result": "failed"}],
        )
        assert changed["rejected"] == ["audit-1"]

        async def read():
            async with app.state.database.session() as session:
                return await session.get(AuditEvent, "audit-1")

        row = client.portal.call(read)
        assert (row.project_id, row.task_id, row.actor_username,
                row.initiated_by_username, row.actor_device_id,
                row.actor_device_name, row.result) == (
                    "project-1", "task-1", "alice", "alice",
                    "browser-1", "Chrome", "succeeded",
                )


def test_audit_batch_rejects_cross_device_and_sensitive_metadata(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
        })
        result = client.portal.call(
            record_audit_batch, app.state.database, "device-1", "batch-1", [
                {**_event("bad-device"), "device_id": "device-2"},
                {**_event("bad-secret"), "metadata": {"content": "secret"}},
            ],
        )
        assert result["rejected"] == ["bad-device", "bad-secret"]


def test_audit_batch_rejects_collision_with_gateway_event(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(AuditEvent(
                        id="gateway-event", action="auth.login", result="success",
                    ))

        client.portal.call(seed)
        result = client.portal.call(
            record_audit_batch, app.state.database, "device-1", "batch-1",
            [_event("gateway-event")],
        )
        assert result["rejected"] == ["gateway-event"]


def test_admin_audit_query_only_exposes_published_project_events(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        assert setup.status_code == 201
        owner_id = setup.json()["user"]["id"]

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(
                        id="device-1", name="PC", public_key="test",
                        app_instance_id="app", version="1.0", status="active",
                    ))
                    session.add(PlatformProject(
                        id="published-1", device_id="device-1",
                        host_project_id="project-1", name="Public",
                        access_mode="remote_published", status="active",
                    ))
                    session.add(PlatformProject(
                        id="private-1", device_id="device-1",
                        host_project_id="project-2", name="Private",
                        access_mode="policy_only", status="active",
                    ))
                    session.add(AuditEvent(
                        id="global-secret", user_id=owner_id,
                        action="auth.login", result="success",
                        metadata_json='{"token":"secret","user_id":"owner"}',
                    ))

        client.portal.call(seed)
        client.portal.call(record_audit_batch, app.state.database,
                           "device-1", "batch-1", [_event("visible")])
        client.portal.call(record_audit_batch, app.state.database,
                           "device-1", "batch-2", [
                               {**_event("hidden"), "project_id": "project-2"},
                           ])
        visible = client.get("/api/admin/audit", params={"project_id": "published-1"})
        assert visible.status_code == 200, visible.text
        assert [item["id"] for item in visible.json()["items"]] == ["visible"]
        hidden = client.get("/api/admin/audit", params={"project_id": "private-1"})
        assert hidden.status_code == 404
        all_events = client.get("/api/admin/audit")
        assert all_events.status_code == 200
        assert "hidden" not in {item["id"] for item in all_events.json()["items"]}
        legacy = next(item for item in all_events.json()["items"]
                      if item["id"] == "global-secret")
        assert legacy["metadata"] == {"user_id": "owner"}

        filtered = client.get("/api/admin/audit", params={
            "user_id": "user-1", "result": "succeeded", "q": "task-1",
            "from_time": "2020-01-01T00:00:00Z",
            "to_time": "2100-01-01T00:00:00Z", "limit": 1,
        })
        assert filtered.status_code == 200, filtered.text
        assert filtered.json()["total"] == 1
        assert [item["id"] for item in filtered.json()["items"]] == ["visible"]
        assert filtered.json()["items"][0]["platform_project_id"] == "published-1"
        assert filtered.json()["items"][0]["project_name"] == "Public"
        assert client.get("/api/admin/audit", params={
            "user_id": owner_id, "result": "succeeded",
        }).json()["total"] == 0
        assert client.get("/api/admin/audit", params={
            "q": "secret",
        }).json()["total"] == 0
        assert client.get("/api/admin/audit", params={
            "from_time": "2100-01-01T00:00:00Z",
        }).json()["total"] == 0
        assert client.get("/api/admin/audit", params={
            "from_time": "2100-01-01T00:00:00Z",
            "to_time": "2020-01-01T00:00:00Z",
        }).status_code == 422
        assert client.get("/api/admin/audit", params={
            "from_time": "2020-01-01T00:00:00",
        }).status_code == 422

    with TestClient(app, base_url="https://gateway.test") as anonymous:
        assert anonymous.get("/api/admin/audit").status_code == 401


def test_department_audit_admin_only_sees_own_department_and_children(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        csrf = setup.json()["csrf_token"]
        users = {}
        for name in ("auditor", "alice", "bob"):
            response = client.post(
                "/api/admin/users", headers={"X-CSRF-Token": csrf},
                json={"username": name, "display_name": name.title(),
                      "password": f"{name.title()}Passphrase-2026!"},
            )
            assert response.status_code == 201, response.text
            users[name] = response.json()["id"]

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(IdentitySource(
                        id="source-1", provider="wecom", tenant_id="tenant-1",
                        client_id="app", secret_env="TEST_SECRET",
                    ))
                    session.add(Device(
                        id="device-1", name="PC", public_key="test",
                        app_instance_id="app", version="1.0", status="active",
                    ))
                    session.add_all([
                        PlatformProject(
                            id="published-1", device_id="device-1",
                            host_project_id="project-1", name="Published",
                            access_mode="remote_published", status="active",
                        ),
                        PlatformProject(
                            id="private-1", device_id="device-1",
                            host_project_id="project-2", name="Private",
                            access_mode="policy_only", status="active",
                        ),
                    ])
                    session.add_all([
                        DirectoryDepartment(
                            id="dept-parent", source_id="source-1",
                            external_id="parent", display_name="Parent",
                        ),
                        DirectoryDepartment(
                            id="dept-child", source_id="source-1",
                            external_id="child", parent_external_id="parent",
                            display_name="Child",
                        ),
                        DirectoryDepartment(
                            id="dept-other", source_id="source-1",
                            external_id="other", display_name="Other",
                        ),
                    ])
                    session.add_all([
                        DirectoryPerson(
                            id="person-alice", source_id="source-1",
                            subject="alice", display_name="Alice",
                            user_id=users["alice"],
                        ),
                        DirectoryPerson(
                            id="person-bob", source_id="source-1",
                            subject="bob", display_name="Bob",
                            user_id=users["bob"],
                        ),
                    ])
                    session.add_all([
                        DirectoryMembership(
                            id="membership-alice", person_id="person-alice",
                            department_id="dept-child",
                        ),
                        DirectoryMembership(
                            id="membership-bob", person_id="person-bob",
                            department_id="dept-other",
                        ),
                        AuditEvent(
                            id="alice-event", user_id=users["alice"],
                            action="auth.login", result="success",
                        ),
                        AuditEvent(
                            id="bob-event", user_id=users["bob"],
                            action="auth.login", result="success",
                        ),
                        AuditEvent(
                            id="alice-scheduled", user_id=None,
                            initiated_by_user_id=users["alice"],
                            action="schedule.trigger", result="success",
                        ),
                        AuditEvent(
                            id="alice-published", user_id=users["alice"],
                            device_id="device-1", project_id="project-1",
                            action="task.start", result="success",
                        ),
                        AuditEvent(
                            id="alice-private", user_id=users["alice"],
                            device_id="device-1", project_id="project-2",
                            action="task.start", result="success",
                        ),
                        AuditEvent(
                            id="global-event", action="platform.setting",
                            result="success",
                        ),
                    ])

        client.portal.call(seed)
        stepped_up = client.post(
            "/api/auth/step-up", headers={"X-CSRF-Token": csrf},
            json={"password": "OwnerPassphrase-2026!"},
        )
        assert stepped_up.status_code == 200
        granted = client.post(
            f"/api/admin/users/{users['auditor']}/roles",
            headers={"X-CSRF-Token": csrf},
            json={"role": "audit_admin", "scope_type": "department",
                  "scope_id": "dept-parent", "include_subdepartments": True},
        )
        assert granted.status_code == 201, granted.text
        assert granted.json()["include_subdepartments"] is True
        role_events = client.get("/api/admin/audit", params={"action": "admin.role.grant"})
        assert role_events.status_code == 200
        assert len(role_events.json()["items"]) == 1
        assert role_events.json()["items"][0]["metadata"] == {
            "user_id": users["auditor"], "role": "audit_admin",
            "scope_type": "department", "scope_id": "dept-parent",
        }
        client.cookies.clear()
        login = client.post("/api/auth/login", json={
            "username": "auditor", "password": "AuditorPassphrase-2026!",
        })
        assert login.status_code == 200, login.text
        csrf = login.json()["csrf_token"]
        changed = client.post("/api/auth/password", headers={"X-CSRF-Token": csrf}, json={
            "current_password": "AuditorPassphrase-2026!",
            "new_password": "AuditorNewPassphrase-2026!",
        })
        assert changed.status_code == 204
        response = client.get("/api/admin/audit")
        assert response.status_code == 200, response.text
        assert {item["id"] for item in response.json()["items"]} == {
            "alice-event", "alice-scheduled", "alice-published",
        }
        scoped_project = client.get("/api/admin/audit", params={
            "project_id": "published-1",
        })
        assert {item["id"] for item in scoped_project.json()["items"]} == {
            "alice-published",
        }
        assert client.get("/api/admin/audit", params={
            "project_id": "private-1",
        }).status_code == 404

        client.cookies.clear()
        owner_login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        owner_csrf = owner_login.json()["csrf_token"]
        client.post("/api/auth/step-up", headers={"X-CSRF-Token": owner_csrf},
                    json={"password": "OwnerPassphrase-2026!"})
        narrowed = client.post(
            f"/api/admin/users/{users['auditor']}/roles",
            headers={"X-CSRF-Token": owner_csrf},
            json={"role": "audit_admin", "scope_type": "department",
                  "scope_id": "dept-parent", "include_subdepartments": False},
        )
        assert narrowed.status_code == 201, narrowed.text
        assert narrowed.json()["include_subdepartments"] is False
        client.cookies.clear()
        client.post("/api/auth/login", json={
            "username": "auditor", "password": "AuditorNewPassphrase-2026!",
        })
        assert client.get("/api/admin/audit").json()["items"] == []

        client.cookies.clear()
        owner_login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        owner_csrf = owner_login.json()["csrf_token"]
        client.post("/api/auth/step-up", headers={"X-CSRF-Token": owner_csrf},
                    json={"password": "OwnerPassphrase-2026!"})
        platform_role = client.post(
            f"/api/admin/users/{users['auditor']}/roles",
            headers={"X-CSRF-Token": owner_csrf},
            json={"role": "audit_admin", "scope_type": "platform"},
        )
        assert platform_role.status_code == 201, platform_role.text
        client.cookies.clear()
        client.post("/api/auth/login", json={
            "username": "auditor", "password": "AuditorNewPassphrase-2026!",
        })
        platform_events = client.get("/api/admin/audit")
        assert platform_events.status_code == 200
        assert {item["id"] for item in platform_events.json()["items"]} >= {
            "alice-event", "bob-event", "global-event", "alice-scheduled",
            "alice-published",
        }
        assert "alice-private" not in {
            item["id"] for item in platform_events.json()["items"]
        }

        async def revoke_roles():
            from sqlalchemy import update
            from gateway.models import AdminAssignment

            async with app.state.database.session() as session:
                async with session.begin():
                    await session.execute(update(AdminAssignment).where(
                        AdminAssignment.user_id == users["auditor"],
                    ).values(revoked_at=datetime.now(timezone.utc)))

        client.portal.call(revoke_roles)
        assert client.get("/api/admin/audit").status_code == 403
