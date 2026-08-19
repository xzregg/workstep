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


async def test_model_pricing_round_trip_persists_currency_rate_and_prices(
    system_settings_client,
):
    client, config_file = system_settings_client

    response = await client.get("/api/system-settings/model-pricing")
    assert response.status_code == 200
    assert response.json() == {
        "currency": "USD",
        "usd_to_cny_rate": 7.2,
        "prices": [],
        "providers": [],
        "standalone_models": [],
    }

    response = await client.put(
        "/api/system-settings/model-pricing",
        json={
            "currency": "CNY",
            "usd_to_cny_rate": 7.18,
            "prices": [{
                "provider_id": "openai",
                "model": "gpt-5",
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
        "model": "gpt-5",
        "input_price": 10.0,
        "output_price": 30.0,
        "cache_price": 2.5,
    }
    assert json.loads(config_file.read_text(encoding="utf-8"))["model_pricing"] == {
        key: response.json()[key]
        for key in ("currency", "usd_to_cny_rate", "prices")
    }


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

    response = await client.get("/api/system-settings/model-pricing")

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
