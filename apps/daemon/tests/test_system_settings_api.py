import json

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


async def test_user_name_rejects_blank_value(system_settings_client):
    client, _ = system_settings_client

    response = await client.put(
        "/api/system-settings",
        json={"user_name": "   "},
    )
    assert response.status_code == 400


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
