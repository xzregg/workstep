import base64
import asyncio
import io
import threading
import zipfile

import httpx
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase
from gateway.models import Device, PlatformProject, UserDevice
from gateway.skills_api import compile_skill_manifest
from gateway.skill_packages import validate_archive
from gateway import skills_api
import pytest


def _archive(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return base64.b64encode(stream.getvalue()).decode()


def test_skill_archive_rejects_symlinks_and_windows_drive_paths():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("SKILL.md", "# Test")
        symlink = zipfile.ZipInfo("outside")
        symlink.create_system = 3
        symlink.external_attr = (0o120777 << 16)
        archive.writestr(symlink, "../../outside")
    with pytest.raises(ValueError):
        validate_archive(base64.b64encode(stream.getvalue()).decode())
    with pytest.raises(ValueError):
        validate_archive(_archive({"SKILL.md": "# Test", "C:/escape.txt": "bad"}))


def test_skill_version_requires_review_and_is_immutable(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        csrf = setup.json()["csrf_token"]
        headers = {"X-CSRF-Token": csrf}
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                    headers=headers)
        skill = client.post("/api/admin/skills", json={
            "name": "Code Review", "slug": "code-review", "description": "Review source",
        }, headers=headers)
        assert skill.status_code == 201, skill.text
        skill_id = skill.json()["id"]
        archive = _archive({"SKILL.md": "# Code Review\n", "notes/readme.txt": "Hello"})
        upload = client.post(f"/api/admin/skills/{skill_id}/versions", json={
            "version": "1.0.0", "archive_base64": archive,
        }, headers=headers)
        assert upload.status_code == 201, upload.text
        version_id = upload.json()["id"]
        assert upload.json()["status"] == "pending_review"
        assert upload.json()["file_count"] == 2
        assert client.post(f"/api/admin/skills/{skill_id}/versions", json={
            "version": "1.0.0", "archive_base64": archive,
        }, headers=headers).status_code == 409
        bad = client.post(f"/api/admin/skills/{skill_id}/versions", json={
            "version": "1.0.1", "archive_base64": _archive({
                "SKILL.md": "# Test", "../escape.txt": "Bad",
            }),
        }, headers=headers)
        assert bad.status_code == 422
        approved = client.post(
            f"/api/admin/skills/{skill_id}/versions/{version_id}/approve",
            headers=headers,
        )
        assert approved.status_code == 200, approved.text
        assert approved.json()["status"] == "approved"
        assert approved.json()["digest"] == upload.json()["digest"]
        assert client.get(f"/api/admin/skills/{skill_id}/versions").json()[
            "versions"][0]["status"] == "approved"


def test_group_skill_catalog_only_allows_reviewed_version_on_linked_project(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        headers = {"X-CSRF-Token": setup.json()["csrf_token"]}
        owner_id = setup.json()["user"]["id"]
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                    headers=headers)
        skill_id = client.post("/api/admin/skills", json={
            "name": "Review", "slug": "review",
        }, headers=headers).json()["id"]
        version_id = client.post(f"/api/admin/skills/{skill_id}/versions", json={
            "version": "1.0.0", "archive_base64": _archive({"SKILL.md": "# Review"}),
        }, headers=headers).json()["id"]
        group_id = client.post("/api/groups", json={
            "name": "Backend", "slug": "backend",
        }, headers=headers).json()["id"]
        leader_id = client.post("/api/admin/users", json={
            "username": "leader", "display_name": "Leader",
            "password": "LeaderPassphrase-2026!",
        }, headers=headers).json()["id"]
        client.post(f"/api/groups/{group_id}/members", json={
            "user_id": leader_id, "role": "leader",
        }, headers=headers)

        async def seed_project():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       status="active", app_instance_id="app", version="1.0"))
                    session.add(PlatformProject(id="project-1", device_id="device-1",
                                                host_project_id="host-1", name="Project",
                                                access_mode="policy_only"))
                    session.add(UserDevice(id="access-1", user_id=owner_id,
                                           device_id="device-1", access_level="edit"))

        client.portal.call(seed_project)
        client.post(f"/api/groups/{group_id}/projects", json={
            "project_id": "project-1",
        }, headers=headers)
        assert client.post(f"/api/admin/groups/{group_id}/skills", json={
            "skill_version_id": version_id,
        }, headers=headers).status_code == 409
        client.post(f"/api/admin/skills/{skill_id}/versions/{version_id}/approve",
                    headers=headers)
        assert client.post(f"/api/admin/groups/{group_id}/skills", json={
            "skill_version_id": version_id,
        }, headers=headers).status_code == 200
        client.cookies.clear()
        login = client.post("/api/auth/login", json={
            "username": "leader", "password": "LeaderPassphrase-2026!",
        })
        headers = {"X-CSRF-Token": login.json()["csrf_token"]}
        client.post("/api/auth/password", json={
            "current_password": "LeaderPassphrase-2026!",
            "new_password": "LeaderNewPassphrase-2026!",
        }, headers=headers)
        assert client.post(f"/api/admin/groups/{group_id}/skills", json={
            "skill_version_id": version_id,
        }, headers=headers).status_code == 403
        assigned = client.post(f"/api/groups/{group_id}/projects/project-1/skills", json={
            "skill_version_id": version_id,
        }, headers=headers)
        assert assigned.status_code == 200, assigned.text
        assert assigned.json()["desired_revision"] == 1
        again = client.post(f"/api/groups/{group_id}/projects/project-1/skills", json={
            "skill_version_id": version_id,
        }, headers=headers)
        assert again.status_code == 200
        assert again.json()["desired_revision"] == 1
        manifest = client.portal.call(
            compile_skill_manifest, app.state.database, app.state.gateway_signer,
            app.state.settings.gateway_id, "device-1", owner_id,
        )
        claims = app.state.gateway_signer.verify_skill_manifest(
            manifest, gateway_id=app.state.settings.gateway_id,
            device_id="device-1", user_id=owner_id,
        )
        assert claims["projects"][0]["skills"][0]["skill_version_id"] == version_id
        download = client.get(f"/api/device/skills/{version_id}", headers={
            "Authorization": f"Bearer {manifest}",
        })
        assert download.status_code == 200, download.text
        assert download.content == base64.b64decode(_archive({"SKILL.md": "# Review"}))
        assert client.post(f"/api/groups/{group_id}/projects/other/skills", json={
            "skill_version_id": version_id,
        }, headers=headers).status_code == 403
        client.cookies.clear()
        owner_login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        owner_headers = {"X-CSRF-Token": owner_login.json()["csrf_token"]}
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                    headers=owner_headers)
        revoked = client.post(
            f"/api/admin/skills/{skill_id}/versions/{version_id}/revoke",
            json={"reason": "Unsafe instructions"}, headers=owner_headers,
        )
        assert revoked.status_code == 200, revoked.text
        assert client.get(f"/api/device/skills/{version_id}", headers={
            "Authorization": f"Bearer {manifest}",
        }).status_code == 403
        later = client.portal.call(
            compile_skill_manifest, app.state.database, app.state.gateway_signer,
            app.state.settings.gateway_id, "device-1", owner_id,
        )
        later_claims = app.state.gateway_signer.verify_skill_manifest(
            later, gateway_id=app.state.settings.gateway_id,
            device_id="device-1", user_id=owner_id,
        )
        assert later_claims["projects"][0]["revision"] == 2
        assert later_claims["projects"][0]["skills"] == []


def test_skill_admin_role_is_separate_from_user_administration(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        owner_headers = {"X-CSRF-Token": setup.json()["csrf_token"]}
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                    headers=owner_headers)
        user_id = client.post("/api/admin/users", json={
            "username": "skillowner", "display_name": "Skill Owner",
            "password": "SkillOwnerPassphrase-2026!",
        }, headers=owner_headers).json()["id"]
        role = client.post(f"/api/admin/users/{user_id}/roles", json={
            "role": "skill_admin", "scope_type": "platform",
        }, headers=owner_headers)
        assert role.status_code == 201, role.text
        client.cookies.clear()
        login = client.post("/api/auth/login", json={
            "username": "skillowner", "password": "SkillOwnerPassphrase-2026!",
        })
        headers = {"X-CSRF-Token": login.json()["csrf_token"]}
        client.post("/api/auth/password", json={
            "current_password": "SkillOwnerPassphrase-2026!",
            "new_password": "SkillOwnerNewPassphrase-2026!",
        }, headers=headers)
        client.post("/api/auth/step-up", json={
            "password": "SkillOwnerNewPassphrase-2026!",
        }, headers=headers)
        assert client.post("/api/admin/skills", json={
            "name": "Review", "slug": "review",
        }, headers=headers).status_code == 201
        assert client.post("/api/admin/users", json={
            "username": "forbidden", "display_name": "Forbidden",
            "password": "ForbiddenPassphrase-2026!",
        }, headers=headers).status_code == 403


@pytest.mark.asyncio
async def test_slow_skill_archive_write_keeps_health_responsive(tmp_path, monkeypatch):
    settings = GatewaySettings(data_dir=tmp_path)
    app = create_app(settings)
    database = GatewayDatabase(settings)
    await database.start()
    app.state.database = database
    started = threading.Event()
    finish = threading.Event()
    original = skills_api.save_archive

    def slow_save(*args):
        started.set()
        assert finish.wait(timeout=3)
        return original(*args)

    monkeypatch.setattr(skills_api, "save_archive", slow_save)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="https://gateway.test") as client:
            setup = await client.post("/api/platform/setup", json={
                "username": "owner", "display_name": "Owner",
                "password": "OwnerPassphrase-2026!",
                "recovery_username": "recovery",
                "recovery_password": "RecoveryPassphrase-2026!",
                "registration_mode": "closed",
            })
            headers = {"X-CSRF-Token": setup.json()["csrf_token"]}
            await client.post("/api/auth/step-up", json={
                "password": "OwnerPassphrase-2026!",
            }, headers=headers)
            skill_id = (await client.post("/api/admin/skills", json={
                "name": "Review", "slug": "review",
            }, headers=headers)).json()["id"]
            upload = asyncio.create_task(client.post(
                f"/api/admin/skills/{skill_id}/versions", json={
                    "version": "1.0.0", "archive_base64": _archive({"SKILL.md": "# Review"}),
                }, headers=headers,
            ))
            assert await asyncio.to_thread(started.wait, 2)
            assert (await asyncio.wait_for(client.get("/api/health"), timeout=0.2)).status_code == 200
            finish.set()
            assert (await upload).status_code == 201
    finally:
        finish.set()
        await database.close()
