import asyncio
import json
from pathlib import Path
import threading
import time

import pytest
from httpx import ASGITransport, AsyncClient

import api.system_settings as system_settings_api
import main
import services.config as config_module
from services.config import ConfigStore


@pytest.fixture
async def system_settings_client(tmp_path, monkeypatch):
    config_file = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()
    monkeypatch.setattr(system_settings_api, "config_store", store)
    client = AsyncClient(
        transport=ASGITransport(app=main.app),
        base_url="http://test",
    )
    yield client, config_file
    await client.aclose()


async def test_user_name_round_trip_persists_to_global_config(system_settings_client):
    client, config_file = system_settings_client

    response = await client.get("/api/system-settings")
    assert response.status_code == 200
    assert response.json()["user_name"] == ""
    assert response.json()["open_mode"] is False
    assert response.json()["device_id"]
    assert response.json()["device_name"]

    response = await client.put(
        "/api/system-settings",
        json={"user_name": "  小王  "},
    )
    assert response.status_code == 200
    assert response.json()["user_name"] == "小王"
    assert json.loads(config_file.read_text(encoding="utf-8"))["user"] == {
        "name": "小王"
    }

    response = await client.get("/api/system-settings")
    assert response.json()["user_name"] == "小王"


async def test_unicode_config_round_trip_with_windows_default_encoding(
    system_settings_client, monkeypatch,
):
    client, config_file = system_settings_client
    original_open = Path.open

    def windows_open(self, mode='r', buffering=-1, encoding=None, errors=None, newline=None):
        if self.parent == config_file.parent and 'b' not in mode and encoding in (None, 'locale'):
            encoding = 'cp1252'
        return original_open(self, mode, buffering, encoding, errors, newline)

    monkeypatch.setattr(Path, 'open', windows_open)
    name = '中文使用者🙂'
    response = await client.put('/api/system-settings', json={'user_name': name})
    assert response.status_code == 200
    assert response.json()['user_name'] == name
    assert json.loads(config_file.read_bytes().decode('utf-8'))['user']['name'] == name
    # A NEW store has to read the file, not return the in-memory cache.
    assert await asyncio.to_thread(ConfigStore().get_user_name) == name
    system_settings_api.config_store.invalidate()
    assert (await client.get('/api/system-settings')).json()['user_name'] == name


@pytest.mark.parametrize('encoding,name', [('cp1252', 'François'), ('gbk', '中文使用者')])
async def test_legacy_local_encoding_config_migrates_without_losing_settings(
    system_settings_client, monkeypatch, encoding, name,
):
    client, config_file = system_settings_client
    original = {'user': {'name': name}, 'projects': {'C:/existing': 'Existing'},
                'device': {'device_id': 'existing-device', 'device_name': 'Existing'}}
    config_file.write_bytes(json.dumps(original, ensure_ascii=False).encode(encoding))
    # Older versions wrote using the OS locale; keep those settings on upgrade.
    monkeypatch.setattr('locale.getencoding', lambda: encoding)
    assert (await client.get('/api/system-settings')).json()['user_name'] == name
    response = await client.put('/api/system-settings', json={'user_name': '升级后🙂'})
    assert response.status_code == 200
    saved = json.loads(config_file.read_bytes().decode('utf-8'))
    assert saved == {**original, 'user': {'name': '升级后🙂'}}
    assert await asyncio.to_thread(ConfigStore().get_user_name) == '升级后🙂'


async def test_unicode_config_slow_write_does_not_block_health(
    system_settings_client, monkeypatch,
):
    client, config_file = system_settings_client
    original_write = Path.write_text
    started, release = threading.Event(), threading.Event()

    def slow_write(self, *args, **kwargs):
        if self.parent == config_file.parent:
            started.set()
            release.wait(timeout=2)
        return original_write(self, *args, **kwargs)

    monkeypatch.setattr(Path, 'write_text', slow_write)
    request = asyncio.create_task(client.put('/api/system-settings', json={'user_name': '中文🙂'}))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        assert not request.done(), 'config write blocked the event loop'
        health = await asyncio.wait_for(client.get('/api/health'), timeout=0.3)
        assert health.status_code == 200
    finally:
        release.set()
        response = await request
    assert response.status_code == 200


async def test_open_mode_round_trip_persists_to_global_config(system_settings_client):
    client, config_file = system_settings_client

    response = await client.put(
        "/api/system-settings",
        json={"open_mode": True},
    )

    assert response.status_code == 200
    assert response.json()["open_mode"] is True
    assert json.loads(config_file.read_text(encoding="utf-8"))["open_mode"] is True
    assert (await client.get("/api/system-settings")).json()["open_mode"] is True


async def test_user_name_rejects_blank_value(system_settings_client):
    client, _ = system_settings_client

    response = await client.put(
        "/api/system-settings",
        json={"user_name": "   "},
    )
    assert response.status_code == 400


async def test_git_scan_depth_defaults_and_persists(system_settings_client):
    client, config_file = system_settings_client
    assert (await client.get('/api/system-settings')).json()['git_scan_depth'] == 5
    for depth in (0, 3, 5):
        response = await client.put('/api/system-settings', json={'git_scan_depth': depth})
        assert response.status_code == 200
        assert response.json()['git_scan_depth'] == depth
        assert json.loads(config_file.read_text())['git_scan_depth'] == depth
        assert ConfigStore().get_git_scan_depth() == depth
    await client.put('/api/system-settings', json={'open_mode': True})
    assert (await client.get('/api/system-settings')).json()['git_scan_depth'] == 5


@pytest.mark.parametrize('depth', [-1, 1.5, '3', True, 9007199254740992])
async def test_git_scan_depth_rejects_invalid_values(system_settings_client, depth):
    client, _ = system_settings_client
    response = await client.put('/api/system-settings', json={'git_scan_depth': depth})
    assert response.status_code == 422
    assert (await client.get('/api/system-settings')).json()['git_scan_depth'] == 5


@pytest.mark.parametrize('method', ['GET', 'PUT'])
async def test_git_settings_slow_disk_does_not_block_event_loop(system_settings_client, monkeypatch, method):
    client, _ = system_settings_client
    await client.get('/api/system-settings')
    store = system_settings_api.config_store
    name = 'get_git_scan_depth' if method == 'GET' else 'set'
    original = getattr(store, name)
    started = threading.Event()
    release = threading.Event()

    def slow_io(*args, **kwargs):
        started.set()
        release.wait(timeout=1.0)
        return original(*args, **kwargs)

    monkeypatch.setattr(store, name, slow_io)
    kwargs = {'json': {'git_scan_depth': 4}} if method == 'PUT' else {}
    request = asyncio.create_task(client.request(method, '/api/system-settings', **kwargs))
    try:
        assert await asyncio.to_thread(started.wait, 2.0)
        assert not request.done(), 'slow config I/O blocked the event loop'
        before = time.monotonic()
        await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.2)
        assert time.monotonic() - before < 0.2
    finally:
        release.set()
        response = await request
    assert response.status_code == 200


async def test_default_project_directory_round_trip_and_clear(system_settings_client, tmp_path):
    client, _ = system_settings_client
    assert (await client.get("/api/system-settings")).json()["default_project_directory"] == ""
    directory = tmp_path / "My Projects"
    directory.mkdir()
    response = await client.put("/api/system-settings", json={"default_project_directory": str(directory)})
    assert response.status_code == 200
    assert response.json()["default_project_directory"] == str(directory)
    assert ConfigStore().get("default_project_directory") == str(directory)
    await client.put("/api/system-settings", json={"open_mode": True})
    assert (await client.get("/api/system-settings")).json()["default_project_directory"] == str(directory)
    response = await client.put("/api/system-settings", json={"default_project_directory": "   "})
    assert response.json()["default_project_directory"] == ""


@pytest.mark.parametrize("path", ["missing", "config.json", "relative/path"])
async def test_default_project_directory_rejects_invalid_paths(system_settings_client, tmp_path, path):
    client, _ = system_settings_client
    await client.get("/api/system-settings")
    value = path if path.startswith("relative") else str(tmp_path / path)
    response = await client.put("/api/system-settings", json={"default_project_directory": value})
    assert response.status_code == 400
    assert (await client.get("/api/system-settings")).json()["default_project_directory"] == ""


async def test_model_pricing_round_trip_persists_currency_rate_and_prices(
    system_settings_client,
):
    client, config_file = system_settings_client

    response = await client.get("/api/system-settings/model-settings")
    assert response.status_code == 200
    assert response.json() == {
        "currency": "USD",
        "usd_to_cny_rate": 7.2,
        "prices": [],
        "providers": [],
        "engines": [],
        "standalone_models": [],
    }

    response = await client.put(
        "/api/system-settings/model-settings",
        json={
            "currency": "CNY",
            "usd_to_cny_rate": 7.18,
            "prices": [{
                "provider_id": "openai",
                "engine_id": None,
                "model": "gpt-5",
                "model_type": "chat",
                "supports_multimodal": True,
                "input_price": 10,
                "output_price": 30,
                "cache_price": 2.5,
            }],
        },
    )

    assert response.status_code == 200
    assert response.json()["currency"] == "CNY"
    assert response.json()["prices"][0] == {
        "provider_id": "openai",
        "engine_id": None,
        "model": "gpt-5",
        "model_type": "chat",
        "supports_multimodal": True,
        "input_price": 10.0,
        "output_price": 30.0,
        "cache_price": 2.5,
    }
    assert json.loads(config_file.read_text(encoding="utf-8"))["model_pricing"] == {
        key: response.json()[key]
        for key in ("currency", "usd_to_cny_rate", "prices")
    }
    assert system_settings_api.config_store.model_supports_multimodal(
        "pydantic_ai",
        "gpt-5",
        "openai",
    ) is True


async def test_model_pricing_returns_enabled_providers_with_cached_models_in_one_response(
    system_settings_client,
    monkeypatch,
):
    client, _ = system_settings_client
    store = system_settings_api.config_store
    store.set("providers", [
        {"id": "enabled", "name": "Enabled", "enabled": True},
        {"id": "disabled", "name": "Disabled", "enabled": False},
    ])
    store.set_provider_models(
        "enabled",
        [{"id": "model-a", "label": "Model A", "description": "cached"}],
        "2026-08-14T00:00:00+00:00",
    )
    store.set("engine_default_models", {
        "codex": "gpt-5",
        "claude": "claude-sonnet",
    })
    store.set_provider_models(
        "disabled",
        [{"id": "model-b", "label": "Model B"}],
        "2026-08-14T00:00:00+00:00",
    )

    response = await client.get("/api/system-settings/model-settings")

    assert response.status_code == 200
    assert response.json()["providers"] == [{
        "id": "enabled",
        "name": "Enabled",
        "models": [{
            "id": "model-a",
            "label": "Model A",
            "description": "cached",
        }],
    }]
    assert response.json()["standalone_models"] == ["claude-sonnet", "gpt-5"]


async def test_model_settings_returns_cached_execution_engine_models_without_fetching(
    system_settings_client,
):
    client, _ = system_settings_client
    store = system_settings_api.config_store
    store.set_engine_models(
        "codex",
        [
            {"id": "gpt-5", "label": "GPT-5", "description": "cached"},
            {"id": "gpt-5-mini", "label": "GPT-5 mini", "description": None},
        ],
        "2026-09-10T00:00:00+00:00",
    )

    response = await client.get("/api/system-settings/model-pricing")

    assert response.status_code == 200
    assert response.json()["engines"] == [{
        "id": "codex",
        "models": [
            {"id": "gpt-5", "label": "GPT-5", "description": "cached"},
            {"id": "gpt-5-mini", "label": "GPT-5 mini", "description": ""},
        ],
    }]


async def test_model_settings_persists_engine_model_metadata(system_settings_client):
    client, config_file = system_settings_client

    response = await client.put(
        "/api/system-settings/model-settings",
        json={
            "currency": "USD",
            "usd_to_cny_rate": 7.2,
            "prices": [{
                "provider_id": None,
                "engine_id": "codex",
                "model": "gpt-5",
                "model_type": "reasoning",
                "supports_multimodal": True,
                "input_price": 1,
                "output_price": 2,
                "cache_price": 0.5,
            }],
        },
    )

    assert response.status_code == 200
    assert response.json()["prices"][0] == {
        "provider_id": None,
        "engine_id": "codex",
        "model": "gpt-5",
        "model_type": "reasoning",
        "supports_multimodal": True,
        "input_price": 1.0,
        "output_price": 2.0,
        "cache_price": 0.5,
    }
    assert json.loads(config_file.read_text(encoding="utf-8"))["model_pricing"]["prices"][0]["engine_id"] == "codex"
    assert system_settings_api.config_store.model_supports_multimodal(
        "codex",
        "gpt-5",
    ) is True


async def test_model_pricing_rejects_duplicate_or_invalid_entries(system_settings_client):
    client, _ = system_settings_client
    duplicate = {
        "currency": "USD",
        "usd_to_cny_rate": 7.2,
        "prices": [
            {"provider_id": None, "model": "same", "input_price": 1, "output_price": 2, "cache_price": 0},
            {"provider_id": None, "model": "same", "input_price": 3, "output_price": 4, "cache_price": 0},
        ],
    }

    response = await client.put("/api/system-settings/model-pricing", json=duplicate)
    invalid_rate = await client.put(
        "/api/system-settings/model-pricing",
        json={"currency": "CNY", "usd_to_cny_rate": 0, "prices": []},
    )
    blank_model = await client.put(
        "/api/system-settings/model-pricing",
        json={
            "currency": "USD",
            "usd_to_cny_rate": 7.2,
            "prices": [{
                "provider_id": None,
                "model": "   ",
                "input_price": 1,
                "output_price": 2,
                "cache_price": 0,
            }],
        },
    )

    assert response.status_code == 400
    assert invalid_rate.status_code == 422
    assert blank_model.status_code == 400


def test_device_identity_is_created_once_in_config_json(tmp_path, monkeypatch):
    config_file = tmp_path / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()

    first = store.get_device_identity()
    second = store.get_device_identity()

    assert first == second
    assert first["device_id"]
    assert first["device_name"]
    assert json.loads(config_file.read_text(encoding="utf-8"))["device"] == first
