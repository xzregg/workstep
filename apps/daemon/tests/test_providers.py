"""Unit tests for the provider registry & client (services.providers)."""

import json
import sqlite3

import httpx
import pytest

from services import providers as provider_service
from engines.core.base import EngineModel


def test_provider_type_presets():
    types = {item["id"]: item for item in provider_service.list_provider_types()}
    assert set(types) == {
        "deepseek",
        "moonshot",
        "openai",
        "anthropic",
        "ollama",
        "custom",
    }
    assert types["deepseek"]["default_base_url"] == "https://api.deepseek.com/v1"
    assert types["moonshot"]["default_base_url"] == "https://api.moonshot.cn/v1"
    assert types["ollama"]["default_base_url"] == "http://localhost:11434/v1"
    assert types["anthropic"]["auth"] == "anthropic"
    assert types["ollama"]["auth"] == "none"
    assert all(item["supports_balance"] is False for item in types.values())


def test_auth_headers_by_provider_type():
    bearer = provider_service.auth_headers({
        "type": "deepseek",
        "api_key": "sk-test",
    })
    assert bearer["Authorization"] == "Bearer sk-test"

    anthropic = provider_service.auth_headers({
        "type": "anthropic",
        "api_key": "sk-ant",
    })
    assert anthropic["x-api-key"] == "sk-ant"
    assert anthropic["anthropic-version"] == "2023-06-01"

    none = provider_service.auth_headers({"type": "ollama", "api_key": ""})
    assert "Authorization" not in none

    anthropic_gateway_chat = provider_service.auth_headers(
        {"type": "anthropic", "api_key": "shared-key"},
        "openai_chat_completions",
    )
    assert anthropic_gateway_chat["Authorization"] == "Bearer shared-key"
    assert "x-api-key" not in anthropic_gateway_chat


def test_protocol_base_urls_are_independent_and_versions_are_preserved():
    provider = {
        "type": "custom",
        "protocols": ["openai_responses", "anthropic_messages"],
        "base_url": "https://legacy.example.com/v1",
        "protocol_base_urls": {
            "openai_responses": "https://openai.example.com/api/v2/",
            "anthropic_messages": "https://anthropic.example.com/proxy/v1",
        },
    }

    assert provider_service.provider_basic_url(
        provider, "openai_responses"
    ) == "https://openai.example.com/api/v2"
    assert provider_service.provider_basic_url(
        provider, "anthropic_messages"
    ) == "https://anthropic.example.com/proxy/v1"
    assert provider_service.provider_runtime_base_url(
        provider, "openai_responses"
    ) == "https://openai.example.com/api/v2"
    assert provider_service.provider_runtime_base_url(
        provider, "anthropic_messages"
    ) == "https://anthropic.example.com/proxy/v1"
    assert provider_service.provider_endpoint_url(
        provider, "anthropic_messages", "models"
    ) == "https://anthropic.example.com/proxy/v1/models"


def test_legacy_single_base_url_applies_to_every_declared_protocol():
    provider = {
        "type": "custom",
        "protocols": ["openai_chat_completions", "anthropic_messages"],
        "base_url": "https://gateway.example.com/v1",
    }

    assert provider_service.provider_endpoint_url(
        provider, "openai_chat_completions", "models"
    ) == "https://gateway.example.com/v1/models"
    assert provider_service.provider_endpoint_url(
        provider, "anthropic_messages", "models"
    ) == "https://gateway.example.com/v1/models"


def test_mask_api_key():
    assert provider_service.mask_api_key("") == ""
    assert provider_service.mask_api_key("short") == "****"
    assert provider_service.mask_api_key("sk-abcdefgh1234") == "sk-a****1234"


def test_validate_provider_values():
    error = provider_service.validate_provider_values(
        name="", type_id="deepseek", base_url="https://api.deepseek.com/v1"
    )
    assert error == "供应商名称不能为空"

    error = provider_service.validate_provider_values(
        name="x", type_id="nope", base_url="https://api.deepseek.com/v1"
    )
    assert error == "不支持的供应商类型"

    error = provider_service.validate_provider_values(
        name="x", type_id="custom", base_url="http://192.168.1.20/v1"
    )
    assert error is None

    assert provider_service.validate_provider_values(
        name="本地模型", type_id="ollama", base_url="http://localhost:11434/v1"
    ) is None


def _write_cc_switch_db(path, providers, app_type="codex"):
    """Create a cc-switch style SQLite DB with the given providers."""
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE providers ("
        "id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, "
        "settings_config TEXT NOT NULL, category TEXT, sort_index INTEGER, "
        "PRIMARY KEY (id, app_type))"
    )
    for provider in providers:
        conn.execute(
            "INSERT INTO providers (id, app_type, name, settings_config, category, sort_index) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                provider["id"],
                provider.get("app_type", app_type),
                provider["name"],
                json.dumps(provider["settings"]),
                provider.get("category", ""),
                provider.get("sort_index", 0),
            ),
        )
    conn.commit()
    conn.close()


def _deepseek_settings():
    return {
        "auth": {"OPENAI_API_KEY": "sk-deepseek-secret"},
        "config": (
            'model_provider = "custom"\n'
            'model = "deepseek-v4-pro[1m]"\n'
            "[model_providers.custom]\n"
            'name = "deepseek"\n'
            'base_url = "https://api.deepseek.com"\n'
            'wire_api = "responses"\n'
        ),
        "modelCatalog": {
            "models": [
                {"model": "deepseek-v4-flash", "displayName": "DeepSeek V4 Flash"},
                {"model": "deepseek-v4-pro[1m]", "displayName": "DeepSeek V4 Pro"},
            ]
        },
    }


def test_cc_switch_scan_discovers_codex_providers(tmp_path, monkeypatch):
    db_path = tmp_path / "cc-switch.db"
    _write_cc_switch_db(db_path, [
        {
            "id": "deepseek-id",
            "name": "DeepSeek",
            "settings": _deepseek_settings(),
            "category": "cn_official",
        },
        {
            "id": "local-id",
            "name": "本地中转",
            "settings": {
                "auth": {"OPENAI_API_KEY": "sk-local"},
                "config": (
                    "[model_providers.custom]\n"
                    'base_url = "http://localhost:3000/v1"\n'
                    'wire_api = "responses"\n'
                ),
            },
        },
        {
            "id": "lan-id",
            "name": "内网中转",
            "settings": {
                "auth": {"OPENAI_API_KEY": "sk-lan"},
                "config": (
                    "[model_providers.custom]\n"
                    'base_url = "http://192.168.50.21:3000/v1"\n'
                ),
            },
        },
        {
            "id": "official-id",
            "name": "OpenAI Official",
            "settings": {"auth": {}, "config": ""},
        },
    ])
    monkeypatch.setattr(provider_service, "CC_SWITCH_DB_PATH", db_path)

    candidates = provider_service.scan_cc_switch_codex_providers()
    by_id = {item["id"]: item for item in candidates}
    assert set(by_id) == {"deepseek-id", "local-id", "lan-id", "official-id"}

    deepseek = by_id["deepseek-id"]
    assert deepseek["name"] == "DeepSeek"
    assert deepseek["type"] == "deepseek"
    assert deepseek["base_url"] == "https://api.deepseek.com"
    assert deepseek["api_key"] == "sk-deepseek-secret"
    assert deepseek["has_key"] is True
    assert deepseek["wire_api"] == "responses"
    assert deepseek["model_ids"] == [
        "deepseek-v4-flash",
        "deepseek-v4-pro[1m]",
    ]
    assert deepseek["error"] is None

    assert by_id["local-id"]["type"] == "custom"
    assert by_id["local-id"]["error"] is None
    assert by_id["lan-id"]["error"] is None
    assert by_id["official-id"]["base_url"] == "https://api.openai.com/v1"
    assert by_id["official-id"]["error"] is None


def test_cc_switch_scan_discovers_claude_code_providers(tmp_path, monkeypatch):
    db_path = tmp_path / "cc-switch.db"
    _write_cc_switch_db(db_path, [
        {
            "id": "claude-deepseek-id",
            "name": "Claude DeepSeek",
            "settings": {
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "sk-ant-secret",
                    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
                    "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1m]",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "DeepSeek Pro",
                },
            },
        },
    ], app_type="claude")
    monkeypatch.setattr(provider_service, "CC_SWITCH_DB_PATH", db_path)

    candidates = provider_service.scan_cc_switch_codex_providers()

    assert candidates == [{
        "id": "claude-deepseek-id",
        "source_type": "claude",
        "name": "Claude DeepSeek",
        "type": "anthropic",
        "protocol": "anthropic_messages",
        "protocols": ["anthropic_messages"],
        "base_url": "https://api.deepseek.com/anthropic",
        "api_key": "sk-ant-secret",
        "has_key": True,
        "wire_api": "messages",
        "model_ids": ["deepseek-v4-pro[1m]", "deepseek-v4-flash"],
        "model_map": {
            "haiku": {
                "model": "deepseek-v4-flash",
                "name": "deepseek-v4-flash",
            },
            "sonnet": {
                "model": "deepseek-v4-pro[1m]",
                "name": "DeepSeek Pro",
            },
        },
        "category": "",
        "error": None,
    }]


def test_cc_switch_scan_non_claude_candidate_has_empty_model_map(tmp_path, monkeypatch):
    db_path = tmp_path / "cc-switch.db"
    _write_cc_switch_db(db_path, [{
        "id": "codex-id",
        "name": "Codex Gateway",
        "settings": _deepseek_settings(),
    }])
    monkeypatch.setattr(provider_service, "CC_SWITCH_DB_PATH", db_path)

    [candidate] = provider_service.scan_cc_switch_providers()

    assert candidate["model_map"] == {}


def test_cc_switch_scan_lists_every_application_type(tmp_path, monkeypatch):
    db_path = tmp_path / "cc-switch.db"
    _write_cc_switch_db(db_path, [
        {
            "id": "claude-desktop-id",
            "app_type": "claude-desktop",
            "name": "Claude Desktop",
            "settings": {"env": {
                "ANTHROPIC_BASE_URL": "https://claude.example.com/v1",
                "ANTHROPIC_API_KEY": "claude-key",
                "ANTHROPIC_MODEL": "claude-model",
            }},
        },
        {
            "id": "gemini-id",
            "app_type": "gemini",
            "name": "Gemini Gateway",
            "settings": {"env": {
                "GEMINI_API_BASE_URL": "https://gemini.example.com/v1",
                "GEMINI_API_KEY": "gemini-key",
                "GEMINI_MODEL": "gemini-model",
            }},
        },
        {
            "id": "hermes-id",
            "app_type": "hermes",
            "name": "Hermes Gateway",
            "settings": {
                "base_url": "http://192.168.50.21:3000/v1",
                "api_key": "hermes-key",
                "api_mode": "chat_completions",
                "model": "hermes-model",
            },
        },
        {
            "id": "openclaw-id",
            "app_type": "openclaw",
            "name": "OpenClaw Gateway",
            "settings": {
                "baseUrl": "https://openclaw.example.com/v1",
                "apiKey": "openclaw-key",
                "api": "openai-completions",
                "models": [{"id": "openclaw-model"}],
            },
        },
        {
            "id": "opencode-id",
            "app_type": "opencode",
            "name": "OpenCode Gateway",
            "settings": {
                "npm": "@ai-sdk/anthropic",
                "options": {
                    "baseURL": "https://opencode.example.com/v1",
                    "apiKey": "opencode-key",
                },
                "models": {"opencode-model": {"name": "OpenCode Model"}},
            },
        },
        {
            "id": "future-id",
            "app_type": "future-app",
            "name": "Future App",
            "settings": {},
        },
    ])
    monkeypatch.setattr(provider_service, "CC_SWITCH_DB_PATH", db_path)

    candidates = provider_service.scan_cc_switch_providers()
    by_source = {item["source_type"]: item for item in candidates}

    assert set(by_source) == {
        "claude-desktop", "gemini", "hermes", "openclaw", "opencode", "future-app",
    }
    assert by_source["claude-desktop"]["type"] == "anthropic"
    assert by_source["gemini"]["api_key"] == "gemini-key"
    assert by_source["hermes"]["base_url"] == "http://192.168.50.21:3000/v1"
    assert by_source["openclaw"]["model_ids"] == ["openclaw-model"]
    assert by_source["opencode"]["type"] == "anthropic"
    assert by_source["future-app"]["error"] == "未找到可导入的 API 地址"


def test_cc_switch_official_configs_use_standard_api_addresses(tmp_path, monkeypatch):
    db_path = tmp_path / "cc-switch.db"
    _write_cc_switch_db(db_path, [
        {
            "id": "codex-official",
            "app_type": "codex",
            "name": "OpenAI Official",
            "settings": {"auth": {}, "config": ""},
        },
        {
            "id": "claude-official",
            "app_type": "claude",
            "name": "Claude Official",
            "settings": {"env": {}},
        },
        {
            "id": "claude-desktop-official",
            "app_type": "claude-desktop",
            "name": "Claude Desktop Official",
            "settings": {"env": {}},
        },
        {
            "id": "gemini-official",
            "app_type": "gemini",
            "name": "Google Official",
            "settings": {"env": {}, "config": {}},
        },
    ])
    monkeypatch.setattr(provider_service, "CC_SWITCH_DB_PATH", db_path)

    by_id = {
        item["id"]: item
        for item in provider_service.scan_cc_switch_providers()
    }

    assert by_id["codex-official"]["base_url"] == "https://api.openai.com/v1"
    assert by_id["claude-official"]["base_url"] == "https://api.anthropic.com/v1"
    assert by_id["claude-desktop-official"]["base_url"] == "https://api.anthropic.com/v1"
    assert by_id["gemini-official"]["base_url"] == (
        "https://generativelanguage.googleapis.com/v1beta/openai"
    )
    assert all(item["error"] is None for item in by_id.values())


def test_cc_switch_scan_missing_db_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(
        provider_service,
        "CC_SWITCH_DB_PATH",
        tmp_path / "no-such-db",
    )
    assert provider_service.scan_cc_switch_codex_providers() == []


def test_detect_provider_type():
    assert provider_service.detect_provider_type("https://api.deepseek.com") == "deepseek"
    assert provider_service.detect_provider_type("https://api.moonshot.cn/v1") == "moonshot"
    assert provider_service.detect_provider_type("https://api.openai.com/v1") == "openai"
    assert provider_service.detect_provider_type("https://api.anthropic.com/v1") == "anthropic"
    assert provider_service.detect_provider_type("http://localhost:11434/v1") == "ollama"
    assert provider_service.detect_provider_type("http://localhost:3000/v1") == "custom"
    assert provider_service.detect_provider_type("https://example.com/v1") == "custom"


@pytest.mark.anyio
async def test_fetch_models_parses_openai_compatible_list():
    async def handler(request):
        assert request.url.path == "/v1/models"
        assert request.headers["authorization"] == "Bearer secret-value"
        return httpx.Response(200, json={
            "data": [
                {"id": "model-b", "owned_by": "vendor"},
                {"id": "model-a", "name": "Model A"},
            ]
        })

    models = await provider_service.fetch_models(
        {
            "type": "deepseek",
            "base_url": "https://gateway.example.com/v1",
            "api_key": "secret-value",
        },
        transport=httpx.MockTransport(handler),
    )

    assert models == [
        EngineModel(id="model-a", label="Model A", description=None),
        EngineModel(id="model-b", label="model-b", description="vendor"),
    ]


@pytest.mark.anyio
async def test_fetch_models_sends_anthropic_headers():
    async def handler(request):
        assert request.url.path == "/v1/models"
        assert request.headers["x-api-key"] == "sk-ant"
        assert request.headers["anthropic-version"] == "2023-06-01"
        return httpx.Response(200, json={"data": [{"id": "claude-test"}]})

    models = await provider_service.fetch_models(
        {
            "type": "anthropic",
            "base_url": "https://api.anthropic.com/v1",
            "api_key": "sk-ant",
        },
        transport=httpx.MockTransport(handler),
    )
    assert [model.id for model in models] == ["claude-test"]


@pytest.mark.anyio
async def test_fetch_models_does_not_guess_anthropic_version_path():
    async def handler(request):
        assert request.url.path == "/models"
        return httpx.Response(200, json={"data": [{"id": "claude-test"}]})

    models = await provider_service.fetch_models(
        {
            "type": "anthropic",
            "base_url": "http://anthropic-gateway.example.com",
            "api_key": "sk-ant",
        },
        transport=httpx.MockTransport(handler),
    )

    assert [model.id for model in models] == ["claude-test"]


@pytest.mark.anyio
async def test_fetch_models_uses_selected_protocol_address_and_auth():
    async def handler(request):
        assert request.url == "https://anthropic.example.com/proxy/v2/models"
        assert request.headers["x-api-key"] == "shared-key"
        assert "authorization" not in request.headers
        return httpx.Response(200, json={"data": [{"id": "claude-test"}]})

    models = await provider_service.fetch_models(
        {
            "type": "custom",
            "protocols": ["openai_chat_completions", "anthropic_messages"],
            "protocol_base_urls": {
                "openai_chat_completions": "https://openai.example.com",
                "anthropic_messages": "https://anthropic.example.com/proxy/v2",
            },
            "base_url": "https://openai.example.com",
            "api_key": "shared-key",
        },
        protocol="anthropic_messages",
        transport=httpx.MockTransport(handler),
    )

    assert [model.id for model in models] == ["claude-test"]


@pytest.mark.anyio
async def test_fetch_models_skips_malformed_items():
    async def handler(request):
        return httpx.Response(200, json={"data": [{"id": 1}, {}, {"id": "ok"}]})

    models = await provider_service.fetch_models(
        {"type": "custom", "base_url": "https://gateway.example.com/v1", "api_key": ""},
        transport=httpx.MockTransport(handler),
    )
    assert [model.id for model in models] == ["ok"]


@pytest.mark.anyio
async def test_chat_completion_direct_call():
    captured = {}
    usage = {}

    async def handler(request):
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "改写后的提示词"}}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 4,
                      "prompt_tokens_details": {"cached_tokens": 2}},
        })

    text = await provider_service.chat_completion(
        {
            "type": "deepseek",
            "base_url": "https://gateway.example.com/v1",
            "api_key": "sk-test",
        },
        "fast-model",
        [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
        ],
        thinking="disabled",
        transport=httpx.MockTransport(handler),
        usage_collector=usage,
    )
    assert text == "改写后的提示词"
    assert usage == {"input_tokens": 11, "output_tokens": 4,
                     "cache_read_input_tokens": 2,
                     "cache_input_included": True}
    assert captured["url"].endswith("/chat/completions")
    assert captured["headers"]["authorization"] == "Bearer sk-test"
    assert captured["body"] == {
        "model": "fast-model",
        "messages": [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
        ],
        "max_tokens": 4096,
        "stream": False,
        "thinking": {"type": "disabled"},
    }


@pytest.mark.anyio
async def test_managed_provider_rejects_unassigned_model_before_network():
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    provider = {
        "type": "custom", "managed": True, "models": ["allowed-model"],
        "protocols": ["openai_chat_completions"],
        "protocol_base_urls": {"openai_chat_completions": "https://api.example.test/v1"},
        "api_key": "managed-secret",
    }
    transport = httpx.MockTransport(handler)
    with pytest.raises(ValueError, match="模型未获平台供应商授权"):
        await provider_service.text_completion(provider, "other-model", [], transport=transport)
    with pytest.raises(ValueError, match="模型未获平台供应商授权"):
        await provider_service.chat_completion(provider, "other-model", [], transport=transport)
    assert calls == []
    assert await provider_service.text_completion(provider, "allowed-model", [],
                                                  transport=transport) == "ok"
    assert len(calls) == 1


@pytest.mark.anyio
async def test_text_completion_supports_anthropic_messages():
    captured = {}
    usage = {}

    async def handler(request):
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "content": [{"type": "text", "text": "Anthropic 改写结果"}],
            "usage": {"input_tokens": 11, "output_tokens": 4,
                      "cache_read_input_tokens": 2,
                      "cache_creation_input_tokens": 3},
        })

    text = await provider_service.text_completion(
        {
            "type": "custom",
            "protocols": ["anthropic_messages"],
            "protocol_base_urls": {
                "anthropic_messages": "https://gateway.example.com/v1",
            },
            "api_key": "sk-ant",
        },
        "claude-model",
        [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
        ],
        protocol="anthropic_messages",
        transport=httpx.MockTransport(handler),
        usage_collector=usage,
    )

    assert text == "Anthropic 改写结果"
    assert usage == {"input_tokens": 11, "output_tokens": 4,
                     "cache_read_input_tokens": 2,
                     "cache_creation_input_tokens": 3,
                     "cache_input_included": False}
    assert captured["url"] == "https://gateway.example.com/v1/messages"
    assert captured["headers"]["x-api-key"] == "sk-ant"
    assert captured["body"] == {
        "model": "claude-model",
        "max_tokens": 4096,
        "stream": False,
        "system": "system prompt",
        "messages": [{"role": "user", "content": "user prompt"}],
    }


@pytest.mark.anyio
async def test_text_completion_supports_openai_responses():
    captured = {}
    usage = {}

    async def handler(request):
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "Responses 改写结果"}],
            }],
            "usage": {"input_tokens": 13, "output_tokens": 5,
                      "input_tokens_details": {"cached_tokens": 3}},
        })

    messages = [
        {"role": "system", "content": "system prompt"},
        {"role": "user", "content": "user prompt"},
    ]
    text = await provider_service.text_completion(
        {
            "type": "custom",
            "protocols": ["openai_responses"],
            "protocol_base_urls": {
                "openai_responses": "https://gateway.example.com/v1",
            },
            "api_key": "sk-openai",
        },
        "gpt-model",
        messages,
        protocol="openai_responses",
        max_tokens=800,
        transport=httpx.MockTransport(handler),
        usage_collector=usage,
    )

    assert text == "Responses 改写结果"
    assert usage == {"input_tokens": 13, "output_tokens": 5,
                     "cache_read_input_tokens": 3,
                     "cache_input_included": True}
    assert captured["url"] == "https://gateway.example.com/v1/responses"
    assert captured["body"] == {
        "model": "gpt-model",
        "input": messages,
        "max_output_tokens": 800,
        "stream": False,
    }


@pytest.mark.anyio
async def test_chat_completion_adds_v1_and_uses_selected_protocol_auth():
    async def handler(request):
        assert request.url == "https://chat.example.com/api/v2/chat/completions"
        assert request.headers["authorization"] == "Bearer shared-key"
        assert "x-api-key" not in request.headers
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "ok"}}],
        })

    text = await provider_service.chat_completion(
        {
            "type": "custom",
            "protocols": ["anthropic_messages", "openai_chat_completions"],
            "protocol_base_urls": {
                "anthropic_messages": "https://anthropic.example.com",
                "openai_chat_completions": "https://chat.example.com/api/v2",
            },
            "base_url": "https://anthropic.example.com",
            "api_key": "shared-key",
        },
        "model",
        [{"role": "user", "content": "hello"}],
        protocol="openai_chat_completions",
        transport=httpx.MockTransport(handler),
    )

    assert text == "ok"


@pytest.mark.anyio
async def test_chat_completion_falls_back_when_thinking_unsupported():
    bodies: list[dict] = []

    async def handler(request):
        bodies.append(json.loads(request.content))
        if "thinking" in bodies[-1]:
            return httpx.Response(400, json={"error": "unknown param: thinking"})
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "改写后的提示词"}}],
        })

    text = await provider_service.chat_completion(
        {"type": "custom", "base_url": "https://gateway.example.com/v1", "api_key": ""},
        "m",
        [{"role": "user", "content": "hi"}],
        thinking="disabled",
        transport=httpx.MockTransport(handler),
    )
    assert text == "改写后的提示词"
    assert len(bodies) == 2
    assert "thinking" not in bodies[1]


@pytest.mark.anyio
async def test_chat_completion_empty_content_raises():
    async def handler(request):
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "", "reasoning_content": "..."}}],
        })

    with pytest.raises(RuntimeError, match="未返回内容"):
        await provider_service.chat_completion(
            {"type": "deepseek", "base_url": "https://gateway.example.com/v1", "api_key": "x"},
            "m",
            [{"role": "user", "content": "hi"}],
            transport=httpx.MockTransport(handler),
        )


@pytest.mark.anyio
async def test_chat_completion_rejects_anthropic_type():
    with pytest.raises(ValueError, match="chat/completions"):
        await provider_service.chat_completion(
            {
                "type": "anthropic",
                "base_url": "https://api.anthropic.com/v1",
                "api_key": "sk-ant",
            },
            "claude-test",
            [{"role": "user", "content": "hi"}],
        )


@pytest.mark.anyio
async def test_chat_completion_requires_config():
    with pytest.raises(ValueError, match="供应商或模型未配置"):
        await provider_service.chat_completion(
            {"type": "deepseek", "base_url": "", "api_key": ""},
            "",
            [],
        )


@pytest.mark.anyio
async def test_chat_completion_malformed_response():
    async def handler(request):
        return httpx.Response(200, json={"choices": []})

    with pytest.raises(RuntimeError, match="响应格式异常"):
        await provider_service.chat_completion(
            {"type": "deepseek", "base_url": "https://gateway.example.com/v1", "api_key": "x"},
            "m",
            [{"role": "user", "content": "hi"}],
            transport=httpx.MockTransport(handler),
        )


@pytest.mark.anyio
async def test_test_connection_success_and_failure():
    async def ok_handler(request):
        return httpx.Response(200, json={"data": [{"id": "a"}, {"id": "b"}]})

    ok = await provider_service.test_connection(
        {"type": "custom", "base_url": "https://gateway.example.com/v1", "api_key": ""},
        transport=httpx.MockTransport(ok_handler),
    )
    assert ok.success is True
    assert "2 个模型" in ok.message

    async def bad_handler(request):
        return httpx.Response(401, json={"error": "unauthorized"})

    bad = await provider_service.test_connection(
        {"type": "custom", "base_url": "https://gateway.example.com/v1", "api_key": "x"},
        transport=httpx.MockTransport(bad_handler),
    )
    assert bad.success is False
    assert "401" in bad.message
