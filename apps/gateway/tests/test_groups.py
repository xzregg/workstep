from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, PlatformProject


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
