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
        response = _setup(client)
        assert response.status_code == 201
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
            assert connection.execute("SELECT must_change_password FROM users WHERE id=?", (user_id,)).fetchone() == (1,)
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
            "username": "blocked", "display_name": "Blocked", "password": "BlockedPassphrase-2026!",
        }).status_code == 403
        assert client.post("/api/auth/password", headers={"X-CSRF-Token": csrf}, json={
            "current_password": "AlicePassphrase-2026!", "new_password": "AliceNewPassphrase-2026!",
        }).status_code == 204
        assert client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "bob", "display_name": "Bob", "password": "BobPassphrase-2026!",
        }).status_code == 201
        assert client.post(f"/api/admin/users/{alice['id']}/roles", json={
            "role": "identity_admin", "scope_type": "platform",
        }, headers={"X-CSRF-Token": csrf}).status_code == 403


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
                {"external_id": "dept-b", "display_name": "B"},
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
        }, headers={"X-CSRF-Token": csrf})
        assert assigned.status_code == 201
        client.cookies.clear()
        csrf = client.post("/api/auth/login", json={
            "username": "alice", "password": "AlicePassphrase-2026!",
        }).json()["csrf_token"]
        assert client.post("/api/auth/password", headers={"X-CSRF-Token": csrf}, json={
            "current_password": "AlicePassphrase-2026!", "new_password": "AliceNewPassphrase-2026!",
        }).status_code == 204
        assert client.post(f"/api/admin/users/{person_b}/disable", headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.post(f"/api/admin/users/{person_a}/disable", headers={"X-CSRF-Token": csrf}).status_code == 204


def test_admin_can_change_registration_policy_without_restart(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client, mode="closed").json()["csrf_token"]
        assert client.get("/api/auth/registration-policy").json() == {"mode": "closed"}
        assert client.put("/api/admin/registration-policy", json={"mode": "open"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        assert client.put("/api/admin/registration-policy", json={"mode": "open"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        assert client.get("/api/auth/registration-policy").json() == {"mode": "open"}
        client.cookies.clear()
        assert client.post("/api/auth/register", json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        }).status_code == 201
