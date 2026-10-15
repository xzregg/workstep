"""Role assets are global files; teams reference them without copying prompts."""
import asyncio
import json
import threading
import time

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def center(tmp_path, monkeypatch):
    from api import role_center
    from services.role_center import RoleCenter

    manager = RoleCenter(tmp_path / "runtime")
    manager.ensure_defaults()
    monkeypatch.setattr(role_center, "manager", manager)
    app = FastAPI()
    app.include_router(role_center.router)
    app.dependency_overrides[role_center.authorize] = lambda: None

    @app.get("/health")
    async def health():
        return {"ok": True}

    return manager, app


async def create_role(client, **changes):
    return await client.post("/api/role-center/roles", json={
        "name": "检索专家", "category": "engineering", "description": "验证检索效果",
        "prompt": "# 角色\n根据真实问题验证引用与检索效果。", **changes,
    })


async def test_shipped_catalog_and_seed_preserve_edits(center):
    manager, app = center
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        catalog = (await client.get("/api/role-center")).json()
        assert len(catalog["roles"]) == 282
        assert len(catalog["categories"]) == 18
        assert all("prompt" not in item for item in catalog["roles"])
        item = (await client.get("/api/role-center/roles/" + catalog["roles"][0]["id"])).json()
        assert item["builtin"] and item["source"]["license"] == "MIT"
        assert item["source"]["commit"] == "bd956db032d907387e6b9ddebff3e18f1de8c679"
        assert item["prompt"].strip()
        update = {key: item[key] for key in ("name", "category", "description", "prompt")}
        update.update(prompt="用户修改的提示词", expected_revision=item["revision"])
        saved = await client.put("/api/role-center/roles/" + item["id"], json=update)
        assert saved.status_code == 200
        await asyncio.to_thread(manager.ensure_defaults)
        reopened = (await client.get("/api/role-center/roles/" + item["id"])).json()
        assert reopened["prompt"] == "用户修改的提示词"
        assert reopened["source"] == item["source"]


async def test_role_and_team_roundtrip_and_stale_revision(center):
    manager, app = center
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        result = await create_role(client)
        assert result.status_code == 201
        role = result.json()
        assert not role["builtin"] and role["source"] is None
        payload = {"name": "检索评审团", "description": "检查检索方案", "prompt": "A 先分析，B 再审核，最后汇总。",
                   "members": [{"role_id": role["id"], "duty": "先设计评估集"}]}
        created = await client.post("/api/role-center/teams", json=payload)
        assert created.status_code == 201
        team = created.json()
        assert team["members"] == payload["members"] and team["prompt"] == payload["prompt"]
        data = {key: role[key] for key in ("name", "category", "description", "prompt")}
        data.update(prompt="修改后的专业提示词", expected_revision=role["revision"])
        assert (await client.put("/api/role-center/roles/" + role["id"], json=data)).status_code == 200
        assert (await client.put("/api/role-center/roles/" + role["id"], json=data)).status_code == 409
        team_path = "/api/role-center/teams/" + team["id"]
        assert (await client.get(team_path)).json()["members"][0]["role_id"] == role["id"]
        payload.update(prompt="B 先审核，再交给 A。", expected_revision=team["revision"])
        assert (await client.put(team_path, json=payload)).status_code == 200
        assert (await client.put(team_path, json=payload)).status_code == 409
        reopened = type(manager)(manager.root)
        assert reopened.get_role(role["id"])["prompt"] == data["prompt"]
        assert reopened.get_team(team["id"])["prompt"] == payload["prompt"]
        assert "修改后的专业提示词" not in (manager.root / "teams" / (team["id"] + ".json")).read_text()


async def test_validation_duplicate_members_and_invalid_paths(center):
    _, app = center
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        for field in ("name", "category", "prompt"):
            assert (await create_role(client, **{field: "  "})).status_code == 422
        role = (await create_role(client)).json()
        assert (await create_role(client)).status_code == 409
        assert (await create_role(client, builtin=True)).status_code == 422
        base = {"name": "评审团", "prompt": "先分析再汇总", "members": []}
        assert (await client.post("/api/role-center/teams", json=base)).status_code == 422
        base["members"] = [{"role_id": "missing", "duty": ""}]
        assert (await client.post("/api/role-center/teams", json=base)).status_code == 422
        base["members"] = [{"role_id": role["id"], "duty": ""}] * 2
        assert (await client.post("/api/role-center/teams", json=base)).status_code == 422
        assert (await client.get("/api/role-center/roles/bad.json")).status_code == 422
        assert (await client.get("/api/role-center/roles/missing")).status_code == 404


async def test_atomic_failure_and_symlink_do_not_damage_roles(center, monkeypatch, tmp_path):
    manager, app = center
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        role = (await create_role(client)).json()
        outside = tmp_path / "outside.json"
        outside.write_text(json.dumps(role))
        (manager.root / "roles" / "linked.json").symlink_to(outside)
        assert (await client.get("/api/role-center/roles/linked")).status_code == 422
        from services import role_center
        def fail(*args):
            raise OSError("模拟慢盘写入失败")
        monkeypatch.setattr(role_center.os, "replace", fail)
        payload = {key: role[key] for key in ("name", "category", "description", "prompt")}
        payload.update(prompt="不能破坏原文件", expected_revision=role["revision"])
        response = await client.put("/api/role-center/roles/" + role["id"], json=payload)
        assert response.status_code == 503
        assert manager.get_role(role["id"])["prompt"] == role["prompt"]


@pytest.mark.parametrize("operation", ["catalog", "get", "save"])
async def test_slow_disk_does_not_block_real_api_health(center, monkeypatch, operation):
    manager, app = center
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        role = (await create_role(client)).json()
        started = threading.Event()
        target = "catalog" if operation == "catalog" else "_read"
        original = getattr(manager, target)
        def slow(*args, **kwargs):
            if operation == "catalog" or args[1] == role["id"]:
                started.set()
                time.sleep(.3)
            return original(*args, **kwargs)
        monkeypatch.setattr(manager, target, slow)
        path = "/api/role-center" if operation == "catalog" else "/api/role-center/roles/" + role["id"]
        if operation == "save":
            payload = {key: role[key] for key in ("name", "category", "description", "prompt")}
            payload["expected_revision"] = role["revision"]
            pending = asyncio.create_task(client.put(path, json=payload))
        else:
            pending = asyncio.create_task(client.get(path))
        assert await asyncio.to_thread(started.wait, 1)
        assert (await asyncio.wait_for(client.get("/health"), .15)).status_code == 200
        assert (await pending).status_code == 200


async def test_project_scoped_actors_cannot_manage_global_role_assets(center):
    _, app = center
    app.dependency_overrides.clear()
    from services.remote_access import ActorSnapshot, actor_context
    actor = ActorSnapshot(actor_id="editor", user_name="editor", device_id="device",
                          device_name="device", source="remote", project_id="project", access_level="edit")
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            assert (await client.get("/api/role-center")).status_code == 403
            assert (await create_role(client)).status_code == 403
