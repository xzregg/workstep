import asyncio
import io
import json
import time
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


def package(root, **changes):
    root.mkdir(parents=True, exist_ok=True)
    manifest = dict(id="ocean", name="海洋", version="1.0.0", schema_version=1, color_scheme="dark")
    manifest.update(changes)
    (root / "skin.json").write_text(json.dumps(manifest))
    (root / "tokens.json").write_text(json.dumps({"bg": "#102030", "accent": "#00aaff"}))
    (root / "components.json").write_text(json.dumps({"styles": {"button": {"base": {"borderRadius": "12px"}}}, "layout": {"sidebarSide": "right", "splitHandleWidth": 10}}))
    return root


@pytest.mark.asyncio
async def test_manual_starting_style_creates_only_an_explicit_package_and_never_overwrites(tmp_path, monkeypatch):
    from services import customization_workspace
    from services.skins import SkinManager, SkinConflict
    workspace = tmp_path / 'workspace'; workspace.mkdir()
    monkeypatch.setattr(customization_workspace, 'workspace_root', lambda: workspace)
    manager = SkinManager(tmp_path / 'runtime')
    source = await manager.validate(str(package(tmp_path / 'reference')))
    target = workspace / 'my-skin'
    assert not target.exists()
    saved = await manager.save_draft(str(target), '', source['skin'])
    assert saved['skin']['tokens']['accent'] == '#00aaff'
    assert len(await manager.list()) == 1
    with pytest.raises(SkinConflict):
        await manager.save_draft(str(target), '', source['skin'])
    with pytest.raises(ValueError):
        await manager.save_draft(str(tmp_path / 'outside'), '', source['skin'])


@pytest.mark.asyncio
async def test_package_registration_export_replacement_and_inheritance(tmp_path):
    from services.skins import SkinManager
    manager = SkinManager(tmp_path / "runtime")
    draft = package(tmp_path / "draft")
    checked = await manager.validate(str(draft))
    assert checked["skin"]["manifest"]["id"] == "ocean"
    assert "button" in checked["coverage"]["overridden"]
    assert "input" in checked["coverage"]["inherited"]
    installed = await manager.register(str(draft))
    assert installed["revision"] == checked["skin"]["revision"]
    assert len(await manager.list()) == 2  # immutable default + ocean
    with pytest.raises(ValueError):
        await manager.register(str(draft))
    package(draft, version="1.0.1")
    changed = await manager.register(str(draft), replace=True)
    assert changed["revision"] != installed["revision"]
    archive = await manager.export("ocean")
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        assert set(z.namelist()) == {"skin.json", "tokens.json", "components.json"}
    await manager.delete("ocean")
    restored = await manager.import_zip(archive)
    assert restored["manifest"]["version"] == "1.0.1"
    assert (await SkinManager(tmp_path / "runtime").get("ocean"))["revision"] == changed["revision"]
    with pytest.raises(ValueError):
        await manager.delete("default")


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    {"tokens": {"bg": "red; display:none"}},
    {"tokens": {"font-scale": "2"}},
    {"tokens": {"bg": "12px"}},
    {"styles": {"missing-component": {"base": {"color": "red"}}}},
    {"styles": {"button": {"base": {"display": "none"}}}},
    {"styles": {"button": {"base": {"backgroundImage": "https://example.com/a.png"}}}},
    {"layout": {"splitHandleWidth": 100}},
    {"layout": {"sidebarSide": "bottom"}},
    {"mobile": {"layout": {"sidebarWidth": 900}}},
])
async def test_invalid_properties_are_rejected(tmp_path, payload):
    from services.skins import SkinManager
    root = package(tmp_path / "draft")
    if "tokens" in payload:
        (root / "tokens.json").write_text(json.dumps(payload["tokens"]))
    else:
        (root / "components.json").write_text(json.dumps(payload))
    with pytest.raises(ValueError):
        await SkinManager(tmp_path / "runtime").validate(str(root))


@pytest.mark.asyncio
async def test_bad_package_does_not_replace_good_install_and_zip_traversal(tmp_path):
    from services.skins import SkinManager
    manager = SkinManager(tmp_path / "runtime")
    root = package(tmp_path / "draft")
    good = await manager.register(str(root))
    (root / "evil.js").write_text("alert(1)")
    with pytest.raises(ValueError):
        await manager.register(str(root), replace=True)
    assert (await manager.get("ocean"))["revision"] == good["revision"]
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("../skin.json", "{}")
    with pytest.raises(ValueError):
        await manager.import_zip(out.getvalue())
    (root / "evil.js").unlink()
    (root / "tokens.json").unlink()
    (root / "tokens.json").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError):
        await manager.validate(str(root))


@pytest.mark.asyncio
async def test_api_slow_disk_does_not_block_health_and_authorization(tmp_path, monkeypatch):
    from services.skins import SkinManager
    from api import skins
    manager = SkinManager(tmp_path / "runtime")
    monkeypatch.setattr(skins, "manager", manager)
    root = package(tmp_path / "draft")
    app = FastAPI()
    app.include_router(skins.router)
    app.dependency_overrides[skins.authorize] = lambda: None
    @app.get("/health")
    async def health(): return {"ok": True}
    read = manager._read_package
    def slow(*args):
        time.sleep(.25)
        return read(*args)
    monkeypatch.setattr(manager, "_read_package", slow)
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        pending = asyncio.create_task(client.post("/api/skins/validate", json={"path": str(root)}))
        await asyncio.sleep(.05)
        assert (await asyncio.wait_for(client.get("/health"), .1)).json()["ok"]
        assert (await pending).status_code == 200
        assert (await client.post("/api/skins/register", json={"path": str(root)})).status_code == 200
        assert (await client.get("/api/skins/ocean")).json()["manifest"]["id"] == "ocean"
        assert (await client.get("/api/skins/ocean/export")).headers["content-type"] == "application/zip"
        draft = (await client.post('/api/skins/validate', json={'path': str(root)})).json()['skin']
        draft['tokens']['accent'] = '#7c65d5'
        pending_edit = asyncio.create_task(client.post('/api/skins/draft', json={'path': str(root), 'expected_revision': draft['revision'], 'skin': draft}))
        await asyncio.sleep(.05)
        assert (await asyncio.wait_for(client.get('/health'), .1)).json()['ok']
        assert (await pending_edit).status_code == 200
    from fastapi import HTTPException
    def forbidden(): raise HTTPException(403, "host only")
    app.dependency_overrides[skins.authorize] = forbidden
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        assert (await client.delete("/api/skins/ocean")).status_code == 403


@pytest.mark.asyncio
async def test_assets_are_revisioned_and_missing_images_rejected(tmp_path):
    from services.skins import SkinManager
    import base64
    manager = SkinManager(tmp_path / "runtime")
    root = package(tmp_path / "draft")
    (root / "assets").mkdir()
    data = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7S0AAAAASUVORK5CYII=")
    (root / "assets" / "wall.png").write_bytes(data)
    (root / "components.json").write_text(json.dumps({"styles": {"body": {"base": {"backgroundImage": "assets/wall.png"}}}, "mobile": {"layout": {"sidebarSide": "left"}}}))
    checked = await manager.validate(str(root))
    assert await manager.asset(checked["skin"]["revision"], "wall.png") == data
    with pytest.raises(ValueError): await manager.asset(checked["skin"]["revision"], "../skin.json")
    (root / "assets" / "wall.png").unlink()
    with pytest.raises(ValueError): await manager.register(str(root))


@pytest.mark.asyncio
async def test_manual_draft_edit_preserves_cli_components_and_rejects_stale_revision(tmp_path):
    from services.skins import SkinManager, SkinConflict
    manager = SkinManager(tmp_path / 'runtime')
    root = package(tmp_path / 'draft')
    original = (await manager.validate(str(root)))['skin']
    changed = {**original, 'manifest': {**original['manifest'], 'name': '手动微调'}, 'layout': {**original['layout'], 'engineAppearance': 'cards'}, 'tokens': {**original['tokens'], 'accent': '#7c65d5'}}
    saved = await manager.save_draft(str(root), original['revision'], changed)
    assert saved['skin']['styles'] == original['styles']
    assert saved['skin']['manifest']['name'] == '手动微调'
    assert saved['skin']['layout']['engineAppearance'] == 'cards'
    assert len(await manager.list()) == 1  # saving a draft never installs it
    with pytest.raises(SkinConflict): await manager.save_draft(str(root), original['revision'], original)
    assert (await manager.validate(str(root)))['skin']['revision'] == saved['skin']['revision']
    installed = await manager.register(str(root))
    snapshot = manager.root / 'skin-assets' / installed['revision']
    with pytest.raises(ValueError): await manager.save_draft(str(snapshot), installed['revision'], installed)


@pytest.mark.asyncio
@pytest.mark.parametrize("access_level", ["read", "edit"])
async def test_actual_project_actor_can_read_only_its_catalog_and_cannot_manage(tmp_path, monkeypatch, access_level):
    from api import skins
    from services.skins import SkinManager
    from services.remote_access import ActorSnapshot, actor_context
    monkeypatch.setattr(skins, "manager", SkinManager(tmp_path / "runtime"))
    app = FastAPI(); app.include_router(skins.router)
    actor = ActorSnapshot(actor_id="viewer", user_name="viewer", device_id="device", device_name="device", source="remote", project_id="project", access_level=access_level)
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            assert (await client.get("/api/skins?project_id=project")).status_code == 200
            assert (await client.get("/api/skins?project_id=other")).status_code == 403
            assert (await client.get("/api/skins/contract?project_id=project")).status_code == 200
            assert (await client.get("/api/skins/default?project_id=project")).status_code == 200
            for endpoint, payload in [("validate", {"path": "/tmp/draft"}), ("draft", {"path": "/tmp/draft", "expected_revision": "a" * 64, "skin": {}}), ("register", {"path": "/tmp/draft"}), ("onboarding", {}), ("export", {"skin_id": "ocean", "output": "/tmp/ocean.zip"})]:
                assert (await client.post(f"/api/skins/{endpoint}?project_id=project", json=payload)).status_code == 403, endpoint
            assert (await client.post("/api/skins/import?project_id=project", content=b"zip")).status_code == 403
            assert (await client.delete("/api/skins/ocean?project_id=project")).status_code == 403
            assert (await client.get("/api/skins/default/export?project_id=project")).status_code == 403
