"""Self-service registration acceptance, including policy changes during hashing."""

import asyncio
import sqlite3
import threading
import time

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.services.identity import IdentityService


def _setup(client, mode="open"):
    return client.post("/api/platform/setup", json={
        "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
        "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
        "registration_mode": mode,
    })


ACCOUNT = {"username": "alice", "display_name": " Alice ",
           "password": "AlicePassphrase-2026!"}


def test_open_registration_creates_only_an_ordinary_account_with_secure_session(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        _setup(client)
        client.cookies.clear()
        registered = client.post("/api/auth/register", json={**ACCOUNT, "role": "super_admin"})
        assert registered.status_code == 201
        assert registered.json()["user"]["display_name"] == "Alice"
        assert ACCOUNT["password"] not in registered.text
        assert "password_hash" not in registered.text
        cookie = registered.headers["set-cookie"]
        assert all(flag in cookie for flag in ("Secure", "HttpOnly", "SameSite=lax"))
        session = client.get("/api/auth/session").json()
        assert session["admin_roles"] == []
        assert session["user"]["username"] == "alice"
        assert client.get("/api/admin/users").status_code == 403
        duplicate = client.post("/api/auth/register", json=ACCOUNT)
        assert duplicate.status_code == 409
        csrf = session["csrf_token"]
        assert client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
        assert client.post("/api/auth/login", json={
            "username": "alice", "password": ACCOUNT["password"],
        }).status_code == 200
    with sqlite3.connect(tmp_path / "workstep_platform.db") as db:
        password_hash, = db.execute("SELECT password_hash FROM users WHERE username='alice'").fetchone()
        assert password_hash.startswith("$argon2id$")
        assert ACCOUNT["password"] not in password_hash
        assert db.execute("SELECT COUNT(*) FROM users WHERE username='alice'").fetchone() == (1,)


def test_pending_registration_has_no_session_until_administrator_approval(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        owner = _setup(client, mode="open_with_approval")
        owner_cookies = dict(client.cookies)
        csrf = owner.json()["csrf_token"]
        client.cookies.clear()
        registration = client.post("/api/auth/register", json=ACCOUNT)
        assert registration.status_code == 202
        assert "set-cookie" not in registration.headers
        assert registration.json()["user"]["status"] == "pending"
        assert client.get("/api/auth/session").status_code == 401
        assert client.post("/api/auth/login", json={
            "username": "alice", "password": ACCOUNT["password"],
        }).status_code == 403
        client.cookies.update(owner_cookies)
        user_id = registration.json()["user"]["id"]
        assert client.post(f"/api/admin/users/{user_id}/approve",
                           headers={"X-CSRF-Token": csrf}).status_code == 204
        client.cookies.clear()
        assert client.post("/api/auth/login", json={
            "username": "alice", "password": ACCOUNT["password"],
        }).status_code == 200


@pytest.mark.parametrize("changes", [
    {"username": "A lice"}, {"username": "ab"}, {"username": "a" * 65},
    {"display_name": "  "}, {"display_name": "a" * 257},
    {"password": "short"}, {"password": "a" * 129},
])
def test_invalid_registration_does_not_create_an_account(tmp_path, changes):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        _setup(client)
        client.cookies.clear()
        assert client.post("/api/auth/register", json={**ACCOUNT, **changes}).status_code == 422
    with sqlite3.connect(tmp_path / "workstep_platform.db") as db:
        assert db.execute("SELECT COUNT(*) FROM users").fetchone() == (2,)


@pytest.mark.parametrize("mode,status", [("closed", 403), ("open_with_approval", 202)])
def test_registration_uses_policy_at_commit_after_slow_password_hash(tmp_path, monkeypatch, mode, status):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        _setup(client)
        original_hash = IdentityService._hash_password

        async def scenario():
            entered, release = asyncio.Event(), asyncio.Event()

            async def delayed(password):
                entered.set()
                await release.wait()
                return await original_hash(password)

            monkeypatch.setattr(IdentityService, "_hash_password", staticmethod(delayed))
            async with AsyncClient(transport=ASGITransport(app=app), base_url="https://gateway.test") as registrar:
                pending = asyncio.create_task(registrar.post("/api/auth/register", json=ACCOUNT))
                await asyncio.wait_for(entered.wait(), 2)
                await IdentityService(app.state.database).set_registration_mode(mode, "test-admin")
                release.set()
                result = await pending
                assert result.status_code == status
                assert "set-cookie" not in result.headers
                assert (await registrar.get("/api/auth/session")).status_code == 401

        client.portal.call(scenario)
    with sqlite3.connect(tmp_path / "workstep_platform.db") as db:
        row = db.execute("SELECT status FROM users WHERE username='alice'").fetchone()
        assert row == (("pending",) if mode == "open_with_approval" else None)


def test_slow_registration_hash_does_not_block_health(tmp_path, monkeypatch):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        _setup(client)
        entered = threading.Event()
        from gateway.services import identity
        original = type(identity._password_hasher).hash

        def slow_hash(self, password):
            entered.set()
            time.sleep(0.7)
            return original(self, password)

        monkeypatch.setattr(type(identity._password_hasher), "hash", slow_hash)

        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url="https://gateway.test") as registrar:
                pending = asyncio.create_task(registrar.post("/api/auth/register", json=ACCOUNT))
                assert await asyncio.to_thread(entered.wait, 2)
                started = time.monotonic()
                assert (await registrar.get("/api/health")).status_code == 200
                assert time.monotonic() - started < 0.5
                assert (await pending).status_code == 201

        client.portal.call(scenario)


def test_concurrent_registration_commits_one_account_and_one_session(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        _setup(client)

        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url="https://gateway.test") as registrar:
                responses = await asyncio.gather(*(
                    registrar.post("/api/auth/register", json=ACCOUNT) for _ in range(2)
                ))
                assert sorted(response.status_code for response in responses) == [201, 409]
                assert "set-cookie" not in next(r for r in responses if r.status_code == 409).headers

        client.portal.call(scenario)
    with sqlite3.connect(tmp_path / "workstep_platform.db") as db:
        assert db.execute("SELECT COUNT(*) FROM users WHERE username='alice'").fetchone() == (1,)
        assert db.execute("SELECT COUNT(*) FROM auth_sessions s JOIN users u ON s.user_id=u.id "
                          "WHERE u.username='alice'").fetchone() == (1,)


def test_uninitialized_platform_first_registration_is_allowed(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        assert client.post("/api/auth/register", json=ACCOUNT).status_code == 201
    with sqlite3.connect(tmp_path / "workstep_platform.db") as db:
        assert db.execute("SELECT COUNT(*) FROM users").fetchone() == (1,)


def test_registration_waiting_for_sqlite_write_lock_keeps_health_responsive(tmp_path):
    from sqlalchemy import event

    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        _setup(client)
        reached_update = threading.Event()
        engine = app.state.database.engine.sync_engine

        def before_execute(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.startswith("UPDATE platform_settings"):
                reached_update.set()

        event.listen(engine, "before_cursor_execute", before_execute)

        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url="https://gateway.test") as registrar:
                pending = asyncio.create_task(registrar.post("/api/auth/register", json=ACCOUNT))
                try:
                    assert await asyncio.to_thread(reached_update.wait, 2)
                    started = time.monotonic()
                    assert (await registrar.get("/api/health")).status_code == 200
                    assert time.monotonic() - started < 0.5
                    assert not pending.done()
                finally:
                    await asyncio.to_thread(lock.rollback)
                assert (await pending).status_code == 201

        try:
            with sqlite3.connect(tmp_path / "workstep_platform.db", check_same_thread=False) as lock:
                lock.execute("BEGIN IMMEDIATE")
                client.portal.call(scenario)
        finally:
            event.remove(engine, "before_cursor_execute", before_execute)
