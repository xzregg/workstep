import sqlite3

import pytest
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings


def _setup(client: TestClient, *, mode: str = "open"):
    return client.post("/api/platform/setup", json={
        "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
        "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
        "registration_mode": mode,
    })


def test_setup_is_single_use_and_creates_recovery_admin(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        assert client.get("/api/platform/status").json() == {"initialized": False}
        response = _setup(client)
        assert response.status_code == 201
        assert client.get("/api/platform/status").json() == {"initialized": True}
        assert response.json()["user"]["username"] == "owner"
        assert response.json()["csrf_token"]
        assert "Secure" in response.headers["set-cookie"]
        assert "HttpOnly" in response.headers["set-cookie"]
        assert "SameSite=lax" in response.headers["set-cookie"]
        assert _setup(client).status_code == 409
        assert client.get("/api/auth/session").json()["user"]["username"] == "owner"
    with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
        assert connection.execute("SELECT COUNT(*) FROM users").fetchone() == (2,)
        assert connection.execute("SELECT COUNT(*) FROM admin_assignments WHERE role='super_admin'").fetchone() == (2,)
        token_hash = connection.execute("SELECT token_hash FROM auth_sessions").fetchone()[0]
        assert len(token_hash) == 64
        assert token_hash not in response.headers["set-cookie"]


def test_session_reports_only_active_management_roles(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client).json()["csrf_token"]
        assert client.get("/api/auth/session").json()["admin_roles"] == ["super_admin"]
        alice = client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        }).json()
        assert client.post("/api/auth/step-up", headers={"X-CSRF-Token": csrf},
                           json={"password": "OwnerPassphrase-2026!"}).status_code == 200
        role = client.post(f"/api/admin/users/{alice['id']}/roles", headers={"X-CSRF-Token": csrf}, json={
            "role": "identity_admin", "scope_type": "platform",
        }).json()["id"]
        client.cookies.clear()
        assert client.post("/api/auth/login", json={
            "username": "alice", "password": "AlicePassphrase-2026!",
        }).status_code == 200
        assert client.get("/api/auth/session").json()["admin_roles"] == ["identity_admin"]
        client.cookies.clear()
        client.post("/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"})
        csrf = client.get("/api/auth/session").json()["csrf_token"]
        assert client.post("/api/auth/step-up", headers={"X-CSRF-Token": csrf},
                           json={"password": "OwnerPassphrase-2026!"}).status_code == 200
        assert client.delete(f"/api/admin/roles/{role}", headers={"X-CSRF-Token": csrf}).status_code == 204
        client.cookies.clear()
        client.post("/api/auth/login", json={"username": "alice", "password": "AlicePassphrase-2026!"})
        assert client.get("/api/auth/session").json()["admin_roles"] == []


def test_admin_access_navigation_uses_the_same_session(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        assert client.get("/api/auth/admin-access").status_code == 401
        _setup(client)
        assert client.get("/api/auth/admin-access").json() == {
            "roles": ["super_admin"], "must_change_password": False, "password_confirmation_required": True,
        }


def test_setup_rejects_nonempty_uninitialized_database(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            connection.execute(
                "INSERT INTO users (id, username, display_name, status) VALUES (?, ?, ?, ?)",
                ("existing", "existing", "Existing", "active"),
            )
        assert _setup(client).status_code == 409
    with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
        assert connection.execute("SELECT COUNT(*) FROM users").fetchone() == (1,)


@pytest.mark.parametrize("mode,status,active", [
    ("open", 201, True),
    ("open_with_approval", 202, False),
    ("closed", 403, False),
])
def test_registration_modes(tmp_path, mode, status, active):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        assert _setup(client, mode=mode).status_code == 201
        client.cookies.clear()
        response = client.post("/api/auth/register", json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        })
        assert response.status_code == status
        assert ("csrf_token" in response.json()) is active
        login = client.post("/api/auth/login", json={"username": "alice", "password": "AlicePassphrase-2026!"})
        assert (login.status_code == 200) is active


def test_login_logout_and_csrf_guard(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        assert _setup(client).status_code == 201
        csrf = client.get("/api/auth/session").json()["csrf_token"]
        assert client.post("/api/auth/logout").status_code == 403
        assert client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
        assert client.get("/api/auth/session").status_code == 401
        assert client.post("/api/auth/login", json={"username": "owner", "password": "wrong"}).status_code == 401
        login = client.post("/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"})
        assert login.status_code == 200
        assert login.json()["csrf_token"]


def test_login_attempts_are_rate_limited(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        assert _setup(client).status_code == 201
        client.cookies.clear()
        for _ in range(5):
            assert client.post("/api/auth/login", json={"username": "owner", "password": "wrong"}).status_code == 401
        assert client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        }).status_code == 429


def test_password_change_and_expired_session(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = _setup(client)
        assert setup.status_code == 201
        assert client.post("/api/auth/password", json={
            "current_password": "wrong", "new_password": "ReplacementPassphrase-2026!",
        }, headers={"X-CSRF-Token": setup.json()["csrf_token"]}).status_code == 403
        assert client.post("/api/auth/password", json={
            "current_password": "OwnerPassphrase-2026!", "new_password": "ReplacementPassphrase-2026!",
        }, headers={"X-CSRF-Token": setup.json()["csrf_token"]}).status_code == 204
        client.cookies.clear()
        assert client.post("/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"}).status_code == 401
        assert client.post("/api/auth/login", json={"username": "owner", "password": "ReplacementPassphrase-2026!"}).status_code == 200
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            connection.execute("UPDATE auth_sessions SET expires_at='2000-01-01 00:00:00' WHERE revoked_at IS NULL")
        assert client.get("/api/auth/session").status_code == 401


def test_admin_creates_and_approves_user_when_registration_closed(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client, mode="closed").json()["csrf_token"]
        created = client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
            "status": "pending",
        })
        assert created.status_code == 201
        user_id = created.json()["id"]
        client.cookies.clear()
        assert client.post("/api/auth/login", json={"username": "alice", "password": "AlicePassphrase-2026!"}).status_code == 403
        owner = client.post("/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"})
        csrf = owner.json()["csrf_token"]
        assert client.post(f"/api/admin/users/{user_id}/approve", headers={"X-CSRF-Token": csrf}).status_code == 204
        client.cookies.clear()
        assert client.post("/api/auth/login", json={"username": "alice", "password": "AlicePassphrase-2026!"}).status_code == 200
        assert client.post("/api/admin/users", json={
            "username": "bob", "display_name": "Bob", "password": "BobPassphrase-2026!",
        }).status_code == 403


def test_last_super_admin_and_recovery_account_cannot_be_disabled(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = _setup(client)
        csrf = setup.json()["csrf_token"]
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            owner_id = connection.execute("SELECT id FROM users WHERE username='owner'").fetchone()[0]
            recovery_id = connection.execute("SELECT id FROM users WHERE username='recovery'").fetchone()[0]
        assert client.post(f"/api/admin/users/{owner_id}/disable", headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "wrong"}, headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={"X-CSRF-Token": csrf}).status_code == 200
        assert client.post(f"/api/admin/users/{recovery_id}/disable", headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.post(f"/api/admin/users/{owner_id}/disable", headers={"X-CSRF-Token": csrf}).status_code == 204
        assert client.get("/api/auth/session").status_code == 401
        recovery = client.post("/api/auth/login", json={"username": "recovery", "password": "RecoveryPassphrase-2026!"})
        assert recovery.status_code == 200
        assert client.post("/api/auth/step-up", json={"password": "RecoveryPassphrase-2026!"}, headers={
            "X-CSRF-Token": recovery.json()["csrf_token"],
        }).status_code == 200
        assert client.post(f"/api/admin/users/{recovery_id}/disable", headers={
            "X-CSRF-Token": recovery.json()["csrf_token"],
        }).status_code == 409


def test_admin_password_reset_requires_step_up(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client).json()["csrf_token"]
        created = client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        })
        assert created.status_code == 201
        user_id = created.json()["id"]
        url = f"/api/admin/users/{user_id}/reset-password"
        body = {"new_password": "TemporaryPassphrase-2026!"}
        assert client.post(url, json=body, headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={"X-CSRF-Token": csrf}).status_code == 200
        assert client.post(url, json=body, headers={"X-CSRF-Token": csrf}).status_code == 204
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            assert connection.execute("SELECT must_change_password FROM users WHERE id=?", (user_id,)).fetchone() == (0,)
        client.cookies.clear()
        assert client.post("/api/auth/login", json={"username": "alice", "password": "AlicePassphrase-2026!"}).status_code == 401
        assert client.post("/api/auth/login", json={"username": "alice", "password": "TemporaryPassphrase-2026!"}).status_code == 200


def test_expired_step_up_requires_password_confirmation_again(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client).json()["csrf_token"]
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            connection.execute("UPDATE auth_sessions SET step_up_expires_at='2000-01-01 00:00:00'")
        assert client.post("/api/admin/users/no-such-user/reset-password", json={
            "new_password": "TemporaryPassphrase-2026!",
        }, headers={"X-CSRF-Token": csrf}).status_code == 403


def test_password_reset_revokes_existing_sessions(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client).json()["csrf_token"]
        created = client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        })
        assert created.status_code == 201
        client.cookies.clear()
        assert client.post("/api/auth/login", json={
            "username": "alice", "password": "AlicePassphrase-2026!",
        }).status_code == 200
        alice_token = client.cookies.get("workstep_gateway_session")
        assert client.get("/api/auth/session").status_code == 200
        client.cookies.clear()
        csrf = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        }).json()["csrf_token"]
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        assert client.post(f"/api/admin/users/{created.json()['id']}/reset-password", json={
            "new_password": "TemporaryPassphrase-2026!",
        }, headers={"X-CSRF-Token": csrf}).status_code == 204
        client.cookies.set("workstep_gateway_session", alice_token)
        assert client.get("/api/auth/session").status_code == 401


def test_recovery_actions_leave_audit_records(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        _setup(client)
        client.cookies.clear()
        assert client.post("/api/auth/login", json={
            "username": "recovery", "password": "RecoveryPassphrase-2026!",
        }).status_code == 200
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            actions = [row[0] for row in connection.execute("SELECT action FROM audit_events")]
        assert "admin.recovery_created" in actions
        assert "auth.recovery_login" in actions


def test_platform_identity_admin_can_manage_users_but_cannot_grant_roles(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client).json()["csrf_token"]
        alice = client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        }).json()
        assert client.post(f"/api/admin/users/{alice['id']}/roles", json={
            "role": "identity_admin", "scope_type": "platform",
        }, headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        assigned = client.post(f"/api/admin/users/{alice['id']}/roles", json={
            "role": "identity_admin", "scope_type": "platform",
        }, headers={"X-CSRF-Token": csrf})
        assert assigned.status_code == 201, assigned.text
        client.cookies.clear()
        csrf = client.post("/api/auth/login", json={
            "username": "alice", "password": "AlicePassphrase-2026!",
        }).json()["csrf_token"]
        assert client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "initial", "display_name": "Initial", "password": "InitialPassphrase-2026!",
        }).status_code == 201
        assert client.post("/api/auth/password", headers={"X-CSRF-Token": csrf}, json={
            "current_password": "AlicePassphrase-2026!", "new_password": "AliceNewPassphrase-2026!",
        }).status_code == 204
        assert client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "bob", "display_name": "Bob", "password": "BobPassphrase-2026!",
        }).status_code == 201
        assert client.post(f"/api/admin/users/{alice['id']}/roles", json={
            "role": "identity_admin", "scope_type": "platform",
        }, headers={"X-CSRF-Token": csrf}).status_code == 403


def test_super_admin_lists_and_revokes_role_assignments(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client).json()["csrf_token"]
        created = client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        }).json()
        assert client.get("/api/admin/roles").status_code == 200
        assert client.delete("/api/admin/roles/no-such-role", headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                           headers={"X-CSRF-Token": csrf}).status_code == 200
        granted = client.post(f"/api/admin/users/{created['id']}/roles", headers={"X-CSRF-Token": csrf}, json={
            "role": "identity_admin", "scope_type": "platform",
        })
        assert granted.status_code == 201
        assignment_id = granted.json()["id"]
        second = client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "bob", "display_name": "Bob", "password": "BobPassphrase-2026!",
        }).json()
        assert client.post(f"/api/admin/users/{second['id']}/roles", headers={"X-CSRF-Token": csrf}, json={
            "role": "identity_admin", "scope_type": "platform",
        }).status_code == 201
        listed = client.get("/api/admin/roles?role=identity_admin&q=Alice&page=1&page_size=1")
        assert listed.status_code == 200, listed.text
        assert listed.json()["total"] == 1
        assert listed.json()["roles"][0]["id"] == assignment_id
        assert listed.json()["roles"][0]["username"] == "alice"
        first_page = client.get("/api/admin/roles?role=identity_admin&sort=username&direction=asc&page_size=1&page=1").json()
        second_page = client.get("/api/admin/roles?role=identity_admin&sort=username&direction=asc&page_size=1&page=2").json()
        assert first_page["total"] == second_page["total"] == 2
        assert [first_page["roles"][0]["username"], second_page["roles"][0]["username"]] == ["alice", "bob"]
        assert client.delete(f"/api/admin/roles/{assignment_id}", headers={"X-CSRF-Token": csrf}).status_code == 204
        assert client.get("/api/admin/roles?role=identity_admin").json()["total"] == 1
        assert client.delete(f"/api/admin/roles/{assignment_id}", headers={"X-CSRF-Token": csrf}).status_code == 404
        assert client.get("/api/admin/roles?page_size=101").status_code == 422


def test_last_super_admin_role_cannot_be_revoked_and_normal_user_cannot_read_roles(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client).json()["csrf_token"]
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                           headers={"X-CSRF-Token": csrf}).status_code == 200
        roles = client.get("/api/admin/roles?role=super_admin").json()["roles"]
        assert len(roles) == 2
        recovery_role = next(role for role in roles if role["username"] == "recovery")
        owner_role = next(role for role in roles if role["username"] == "owner")
        assert client.delete(f"/api/admin/roles/{recovery_role['id']}", headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.delete(f"/api/admin/roles/{owner_role['id']}", headers={"X-CSRF-Token": csrf}).status_code == 204
        client.cookies.clear()
        csrf = client.post("/api/auth/login", json={"username": "recovery",
                          "password": "RecoveryPassphrase-2026!"}).json()["csrf_token"]
        assert client.post("/api/auth/step-up", json={"password": "RecoveryPassphrase-2026!"},
                           headers={"X-CSRF-Token": csrf}).status_code == 200
        assert client.delete(f"/api/admin/roles/{recovery_role['id']}", headers={"X-CSRF-Token": csrf}).status_code == 409
        client.cookies.clear()
        assert client.post("/api/auth/login", json={"username": "owner",
                          "password": "OwnerPassphrase-2026!"}).status_code == 200
        assert client.get("/api/admin/roles").status_code == 403


def test_admin_department_choices_are_active_and_paged(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client).json()["csrf_token"]
        source = client.post("/api/admin/identity-sources", headers={"X-CSRF-Token": csrf}, json={
            "provider": "wecom", "tenant_id": "tenant-a", "client_id": "app",
            "agent_id": "10001", "secret_env": "WORKSTEP_TEST_WECOM_SECRET",
        }).json()["id"]
        assert client.post(f"/api/admin/identity-sources/{source}/sync", headers={"X-CSRF-Token": csrf}, json={
            "departments": [{"external_id": f"dept-{index}", "display_name": f"Team {index}"}
                            for index in range(3)], "people": [],
        }).status_code == 200
        listed = client.get("/api/admin/departments?q=Team&sort=display_name&direction=asc&page=2&page_size=1")
        assert listed.status_code == 200, listed.text
        assert listed.json()["total"] == 3
        assert listed.json()["departments"][0]["display_name"] == "Team 1"
        assert client.get("/api/admin/departments?page_size=101").status_code == 422
        client.cookies.clear()
        assert client.get("/api/admin/departments").status_code == 401


def test_department_admin_only_manages_members_in_scope(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client).json()["csrf_token"]
        alice = client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        }).json()
        source = client.post("/api/admin/identity-sources", headers={"X-CSRF-Token": csrf}, json={
            "provider": "wecom", "tenant_id": "tenant-a", "client_id": "app",
            "agent_id": "10001", "secret_env": "WORKSTEP_TEST_WECOM_SECRET",
        }).json()["id"]
        assert client.post(f"/api/admin/identity-sources/{source}/sync", headers={"X-CSRF-Token": csrf}, json={
            "departments": [
                {"external_id": "dept-a", "display_name": "A"},
                {"external_id": "dept-b", "display_name": "B", "parent_external_id": "dept-a"},
            ],
            "people": [
                {"subject": "person-a", "display_name": "甲", "department_ids": ["dept-a"]},
                {"subject": "person-b", "display_name": "乙", "department_ids": ["dept-b"]},
            ],
        }).status_code == 200
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            dept_id = connection.execute("SELECT id FROM directory_departments WHERE external_id='dept-a'").fetchone()[0]
            person_a = connection.execute("SELECT user_id FROM directory_people WHERE subject='person-a'").fetchone()[0]
            person_b = connection.execute("SELECT user_id FROM directory_people WHERE subject='person-b'").fetchone()[0]
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        assigned = client.post(f"/api/admin/users/{alice['id']}/roles", json={
            "role": "identity_admin", "scope_type": "department", "scope_id": dept_id,
            "include_subdepartments": False,
        }, headers={"X-CSRF-Token": csrf})
        assert assigned.status_code == 201
        scoped_role = client.get("/api/admin/roles?role=identity_admin").json()["roles"][0]
        assert scoped_role["scope_name"] == "A"
        client.cookies.clear()
        csrf = client.post("/api/auth/login", json={
            "username": "alice", "password": "AlicePassphrase-2026!",
        }).json()["csrf_token"]
        assert client.post("/api/auth/password", headers={"X-CSRF-Token": csrf}, json={
            "current_password": "AlicePassphrase-2026!", "new_password": "AliceNewPassphrase-2026!",
        }).status_code == 204
        scoped = client.get("/api/admin/users?page=1&page_size=10")
        assert scoped.status_code == 200, scoped.text
        assert [user["id"] for user in scoped.json()["users"]] == [person_a]
        assert scoped.json()["total"] == 1
        assert client.post(f"/api/admin/users/{person_b}/disable", headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.post(f"/api/admin/users/{person_a}/disable", headers={"X-CSRF-Token": csrf}).status_code == 204
        client.cookies.clear()
        owner = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        owner_csrf = owner.json()["csrf_token"]
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={
            "X-CSRF-Token": owner_csrf,
        }).status_code == 200
        assert client.post(f"/api/admin/users/{alice['id']}/roles", json={
            "role": "identity_admin", "scope_type": "department", "scope_id": dept_id,
            "include_subdepartments": True,
        }, headers={"X-CSRF-Token": owner_csrf}).status_code == 201
        client.cookies.clear()
        client.post("/api/auth/login", json={
            "username": "alice", "password": "AliceNewPassphrase-2026!",
        })
        assert {user["id"] for user in client.get("/api/admin/users").json()["users"]} == {person_a, person_b}


def test_user_list_filters_and_pages_with_server_scope(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client).json()["csrf_token"]
        for username, status in (("alice", "active"), ("bob", "pending"), ("carol", "active")):
            created = client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
                "username": username, "display_name": username.title(),
                "password": "TemporaryPassphrase-2026!", "status": status,
            })
            assert created.status_code == 201
        pending = client.get("/api/admin/users?status=pending&page=1&page_size=2")
        assert pending.status_code == 200, pending.text
        assert pending.json()["total"] == 1
        assert [user["username"] for user in pending.json()["users"]] == ["bob"]
        first = client.get("/api/admin/users?sort=username&direction=asc&page=1&page_size=2").json()
        second = client.get("/api/admin/users?sort=username&direction=asc&page=2&page_size=2").json()
        assert first["total"] == 5
        assert [user["username"] for user in first["users"]] == ["alice", "bob"]
        assert [user["username"] for user in second["users"]] == ["carol", "owner"]
        assert [user["username"] for user in client.get("/api/admin/users?q=ali").json()["users"]] == ["alice"]
        assert client.get("/api/admin/users?page_size=101").status_code == 422
        client.cookies.clear()
        assert client.post("/api/auth/login", json={
            "username": "alice", "password": "TemporaryPassphrase-2026!",
        }).status_code == 200
        csrf = client.get("/api/auth/session").json()["csrf_token"]
        assert client.post("/api/auth/password", headers={"X-CSRF-Token": csrf}, json={
            "current_password": "TemporaryPassphrase-2026!", "new_password": "AliceNewPassphrase-2026!",
        }).status_code == 204
        assert client.get("/api/admin/users").status_code == 403


def test_admin_can_change_registration_policy_without_restart(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client, mode="closed").json()["csrf_token"]
        assert client.get("/api/auth/registration-policy").json() == {"mode": "closed", "password_login_enabled": True}
        assert client.put("/api/admin/registration-policy", json={"mode": "open"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        assert client.put("/api/admin/registration-policy", json={"mode": "open"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        assert client.get("/api/auth/registration-policy").json() == {"mode": "open", "password_login_enabled": True}
        client.cookies.clear()
        assert client.post("/api/auth/register", json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        }).status_code == 201
