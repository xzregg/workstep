from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.capabilities import compiled_device_policy
from gateway.config import GatewaySettings
from gateway.external_identity import ExternalIdentityService
from gateway.models import (Device, DirectoryDepartment, DirectoryPerson, GroupMembership,
                            PlatformProject, UserGroup)
from sqlalchemy import select


def test_group_leader_can_manage_only_own_skill_projects(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        owner_csrf = setup.json()["csrf_token"]
        assert client.post("/api/auth/step-up", json={
            "password": "OwnerPassphrase-2026!",
        }, headers={"X-CSRF-Token": owner_csrf}).status_code == 200
        leader = client.post("/api/admin/users", json={
            "username": "leader", "display_name": "Leader", "password": "LeaderPassphrase-2026!",
        }, headers={"X-CSRF-Token": owner_csrf})
        assert leader.status_code == 201
        leader_id = leader.json()["id"]
        member = client.post("/api/admin/users", json={
            "username": "member", "display_name": "Member", "password": "MemberPassphrase-2026!",
        }, headers={"X-CSRF-Token": owner_csrf})
        member_id = member.json()["id"]

        async def seed_projects():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       status="active", app_instance_id="app", version="1.0"))
                    session.add(PlatformProject(id="project-1", device_id="device-1",
                                                host_project_id="host-1", name="Project",
                                                access_mode="policy_only"))
                    session.add(PlatformProject(id="project-2", device_id="device-1",
                                                host_project_id="host-2", name="Other",
                                                access_mode="policy_only"))

        client.portal.call(seed_projects)
        group = client.post("/api/groups", json={"name": "Backend", "slug": "backend"},
                            headers={"X-CSRF-Token": owner_csrf})
        assert group.status_code == 201, group.text
        group_id = group.json()["id"]
        assert client.post(f"/api/groups/{group_id}/members", json={
            "user_id": leader_id, "role": "leader",
        }, headers={"X-CSRF-Token": owner_csrf}).status_code == 200
        assert client.post(f"/api/groups/{group_id}/projects", json={
            "project_id": "project-1",
        }, headers={"X-CSRF-Token": owner_csrf}).status_code == 200
        client.cookies.clear()
        login = client.post("/api/auth/login", json={
            "username": "leader", "password": "LeaderPassphrase-2026!",
        })
        leader_csrf = login.json()["csrf_token"]
        assert client.post("/api/auth/password", json={
            "current_password": "LeaderPassphrase-2026!",
            "new_password": "LeaderNewPassphrase-2026!",
        }, headers={"X-CSRF-Token": leader_csrf}).status_code == 204
        listing = client.get("/api/groups")
        assert listing.status_code == 200, listing.text
        assert [item["id"] for item in listing.json()["groups"]] == [group_id]
        projects = client.get(f"/api/groups/{group_id}/projects")
        assert projects.status_code == 200
        assert projects.json()["projects"][0]["id"] == "project-1"
        assert "host_project_id" not in projects.text
        assert client.post(f"/api/groups/{group_id}/members", json={
            "user_id": member_id, "role": "member",
        }, headers={"X-CSRF-Token": leader_csrf}).status_code == 200
        members = client.get(f"/api/groups/{group_id}/members")
        assert members.status_code == 200
        assert members.json()["members"] == [{
            "user_id": leader_id, "username": "leader", "display_name": "Leader",
            "role": "leader", "source": "manual",
        }, {
            "user_id": member_id, "username": "member", "display_name": "Member",
            "role": "member", "source": "manual",
        }]
        assert client.post(f"/api/groups/{group_id}/members", json={
            "user_id": member_id, "role": "leader",
        }, headers={"X-CSRF-Token": leader_csrf}).status_code == 403
        assert client.delete(f"/api/groups/{group_id}/members/{member_id}",
                             headers={"X-CSRF-Token": leader_csrf}).status_code == 204
        assert client.post(f"/api/groups/{group_id}/projects", json={
            "project_id": "project-2",
        }, headers={"X-CSRF-Token": leader_csrf}).status_code == 403
        assert client.post("/api/groups", json={"name": "Other", "slug": "other"},
                           headers={"X-CSRF-Token": leader_csrf}).status_code == 403
        client.cookies.clear()
        owner_login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        assert client.delete(f"/api/groups/{group_id}/members/{leader_id}", headers={
            "X-CSRF-Token": owner_login.json()["csrf_token"],
        }).status_code == 204
        client.cookies.clear()
        client.post("/api/auth/login", json={
            "username": "leader", "password": "LeaderNewPassphrase-2026!",
        })
        assert client.get(f"/api/groups/{group_id}/projects").status_code == 403
        assert client.get(f"/api/groups/{group_id}/members").status_code == 403


def test_external_department_group_tracks_directory_members_without_replacing_group(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        csrf = setup.json()["csrf_token"]
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                    headers={"X-CSRF-Token": csrf})
        service = ExternalIdentityService(app.state.database)
        source = client.portal.call(service.create_source, "wecom", "corp-a", "app",
                                    "SECRET_ENV", "1001")
        client.portal.call(service.full_sync, source.id, [{
            "external_id": "dept-1", "display_name": "Backend",
        }], [{"subject": "employee-1", "display_name": "Alice",
             "department_ids": ["dept-1"]}])

        async def department_id():
            async with app.state.database.session() as session:
                return await session.scalar(select(DirectoryDepartment.id).where(
                    DirectoryDepartment.source_id == source.id,
                    DirectoryDepartment.external_id == "dept-1",
                ))

        group = client.post("/api/groups", json={
            "name": "Backend", "slug": "backend", "source_type": "external_department",
            "external_department_id": client.portal.call(department_id),
        }, headers={"X-CSRF-Token": csrf})
        assert group.status_code == 201, group.text
        group_id = group.json()["id"]

        async def membership():
            async with app.state.database.session() as session:
                row = await session.scalar(select(GroupMembership).where(
                    GroupMembership.group_id == group_id,
                ))
                return row.source if row and row.revoked_at is None else None

        assert client.portal.call(membership) == "directory_sync"
        async def seed_project_and_person():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="pc-1", name="PC", public_key="test", status="active",
                                       app_instance_id="app-1", version="1.0"))
                    session.add(PlatformProject(id="project-1", device_id="pc-1",
                                                host_project_id="host-1", name="Project",
                                                access_mode="remote_published", status="active"))
                return await session.scalar(select(DirectoryPerson.user_id).where(
                    DirectoryPerson.source_id == source.id,
                    DirectoryPerson.subject == "employee-1",
                ))

        person_id = client.portal.call(seed_project_and_person)
        assert client.post(f"/api/admin/projects/project-1/task-create-groups/{group_id}",
                           json={"effect": "allow"}, headers={"X-CSRF-Token": csrf}).status_code == 200
        before = client.portal.call(compiled_device_policy, app.state.database, "pc-1", person_id)
        assert before[3] == ["host-1"]
        client.portal.call(service.full_sync, source.id, [{
            "external_id": "dept-1", "display_name": "Backend Renamed",
        }], [])
        assert client.portal.call(membership) is None
        after = client.portal.call(compiled_device_policy, app.state.database, "pc-1", person_id)
        assert after[0] > before[0]
        assert after[3] == []

        async def current_group():
            async with app.state.database.session() as session:
                return await session.get(UserGroup, group_id)

        assert client.portal.call(current_group).id == group_id
