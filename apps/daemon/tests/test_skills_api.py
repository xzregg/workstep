from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

import api.skills as skills_api
from services.skill_center import SkillCenter


def _write_skill(root: Path, name: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name} description\n---\n",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_skill_api_lists_toggles_and_rejects_unknown_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = SimpleNamespace(id="p1", name="Demo", path=tmp_path / "project")
    source = tmp_path / "home" / ".agents" / "skills"
    _write_skill(source / "review", "review")
    _write_skill(source / "research", "research")
    center = SkillCenter(source_roots={"agents": source})
    manager = SimpleNamespace(
        get_project_by_id=lambda project_id: project if project_id == "p1" else None
    )
    monkeypatch.setattr(skills_api, "project_manager", manager)
    monkeypatch.setattr(skills_api, "skill_center", center)
    app = FastAPI()
    app.include_router(skills_api.router)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        listed = await client.get("/api/skills", params={"project_id": "p1"})
        assert listed.status_code == 200
        skill = listed.json()["skills"][0]
        assert skill["enabled"] is False

        toggled = await client.put(
            "/api/skills/projects/p1",
            json={"skill_id": skill["skill_id"], "enabled": True},
        )
        assert toggled.status_code == 200
        assert toggled.json()["skills"][0]["enabled"] is True

        skill_ids = [item["skill_id"] for item in listed.json()["skills"]]
        batch = await client.put(
            "/api/skills/projects/p1/batch",
            json={"skill_ids": skill_ids, "enabled": True},
        )
        assert batch.status_code == 200
        assert all(item["enabled"] for item in batch.json()["skills"])

        rescanned = await client.post("/api/skills/rescan", params={"project_id": "p1"})
        assert rescanned.status_code == 200
        assert rescanned.json()["skills"][0]["sync_status"] == "synced"

        missing = await client.get("/api/skills", params={"project_id": "missing"})
        assert missing.status_code == 404
        no_project = await client.get("/api/skills")
        assert no_project.status_code == 400
