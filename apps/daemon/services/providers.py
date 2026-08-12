"""Provider registry & client — shared LLM API providers.

Providers hold API credentials (``base_url`` + ``api_key``) once and are
reused by API-driven engines (currently Pydantic AI). Built-in presets cover
common OpenAI-compatible services (DeepSeek, Kimi/Moonshot, OpenAI), the
native Anthropic Messages API, local runners (Ollama) and arbitrary custom
OpenAI-compatible / Anthropic-compatible endpoints.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sqlite3
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from engines.core.base import EngineModel, EngineTestResult
from engines.core.schema import validate_api_base_url

logger = logging.getLogger(__name__)

CC_SWITCH_DB_PATH = Path.home() / ".cc-switch" / "cc-switch.db"


@dataclass(frozen=True)
class ProviderType:
    id: str
    label: str
    default_base_url: str
    auth: str  # bearer | anthropic | none
    supports_balance: bool = False
    help: str = ""


PROVIDER_TYPES: dict[str, ProviderType] = {
    "deepseek": ProviderType(
        id="deepseek",
        label="DeepSeek",
        default_base_url="https://api.deepseek.com/v1",
        auth="bearer",
        help="DeepSeek 官方 OpenAI-compatible 接口",
    ),
    "moonshot": ProviderType(
        id="moonshot",
        label="Kimi（Moonshot）",
        default_base_url="https://api.moonshot.cn/v1",
        auth="bearer",
        help="Moonshot Kimi OpenAI-compatible 接口",
    ),
    "openai": ProviderType(
        id="openai",
        label="OpenAI",
        default_base_url="https://api.openai.com/v1",
        auth="bearer",
        help="OpenAI 官方接口",
    ),
    "anthropic": ProviderType(
        id="anthropic",
        label="Anthropic",
        default_base_url="https://api.anthropic.com/v1",
        auth="anthropic",
        help="Anthropic Messages API（x-api-key 鉴权）",
    ),
    "ollama": ProviderType(
        id="ollama",
        label="Ollama（本地）",
        default_base_url="http://localhost:11434/v1",
        auth="none",
        help="本地模型运行器，API Key 可留空",
    ),
    "custom": ProviderType(
        id="custom",
        label="自定义",
        default_base_url="",
        auth="bearer",
        help="任意 OpenAI-compatible 或 Anthropic-compatible 接口",
    ),
}

VALID_AUTH_STYLES = {"bearer", "anthropic", "none"}

CC_SWITCH_DEFAULT_BASE_URLS = {
    "codex": "https://api.openai.com/v1",
    "claude": "https://api.anthropic.com/v1",
    "claude-desktop": "https://api.anthropic.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
}


def get_type_meta(type_id: str) -> ProviderType | None:
    return PROVIDER_TYPES.get(type_id)


def list_provider_types() -> list[dict]:
    return [asdict(item) for item in PROVIDER_TYPES.values()]


def mask_api_key(api_key: str) -> str:
    """Mask a secret key, keeping only a short prefix and suffix."""
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "****"
    return f"{api_key[:4]}****{api_key[-4:]}"


def auth_headers(provider: dict) -> dict[str, str]:
    """Build per-provider auth headers for OpenAI-compatible / Anthropic calls."""
    provider_type = get_type_meta(str(provider.get("type") or "custom"))
    auth = provider_type.auth if provider_type else "bearer"
    api_key = str(provider.get("api_key") or "")
    if auth == "anthropic":
        headers = {"anthropic-version": "2023-06-01", "Accept": "application/json"}
        if api_key:
            headers["x-api-key"] = api_key
        return headers
    if auth == "bearer" and api_key:
        return {"Accept": "application/json", "Authorization": f"Bearer {api_key}"}
    return {"Accept": "application/json"}


def validate_provider_values(
    *,
    name: str,
    type_id: str,
    base_url: str,
) -> str | None:
    """Validate provider form values; return an error message or None."""
    if not name:
        return "供应商名称不能为空"
    provider_type = get_type_meta(type_id)
    if provider_type is None:
        return "不支持的供应商类型"
    if not base_url:
        return "API 地址不能为空"
    url_error = validate_api_base_url(base_url)
    if url_error:
        return url_error
    return None


def detect_provider_type(base_url: str) -> str:
    """Guess the WorkStep provider type from a base URL host."""
    try:
        parsed = urlparse(base_url)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        host, port = "", None
    if "deepseek" in host:
        return "deepseek"
    if "moonshot" in host:
        return "moonshot"
    if "openai" in host:
        return "openai"
    if "anthropic" in host:
        return "anthropic"
    if "ollama" in host or (host in {"localhost", "127.0.0.1"} and port == 11434):
        return "ollama"
    return "custom"


def _parse_cc_switch_toml(config_text: str) -> dict[str, Any]:
    """Extract base_url / wire_api / model from a cc-switch codex config."""
    result: dict[str, Any] = {}
    try:
        import tomllib

        data = tomllib.loads(config_text)
    except Exception:
        data = None
    if isinstance(data, dict):
        for section in (data.get("model_providers") or {}).values():
            if isinstance(section, dict) and section.get("base_url"):
                result["base_url"] = str(section["base_url"])
                if section.get("wire_api"):
                    result["wire_api"] = str(section["wire_api"])
                break
        if data.get("model"):
            result["model"] = str(data["model"])
        return result
    url = re.search(r'base_url\s*=\s*"([^"]+)"', config_text)
    if url:
        result["base_url"] = url.group(1)
    wire = re.search(r'wire_api\s*=\s*"([^"]+)"', config_text)
    if wire:
        result["wire_api"] = wire.group(1)
    model = re.search(r'^\s*model\s*=\s*"([^"]+)"', config_text, re.MULTILINE)
    if model:
        result["model"] = model.group(1)
    return result


def _cc_switch_candidate(row: dict[str, Any]) -> dict[str, Any] | None:
    """Convert one cc-switch provider row into an import candidate."""
    try:
        settings = json.loads(str(row.get("settings_config") or "{}"))
    except (TypeError, ValueError):
        settings = {}
    if not isinstance(settings, dict):
        settings = {}
    name = str(row.get("name") or row.get("id") or "").strip()
    app_type = str(row.get("app_type") or "codex")
    parsed: dict[str, Any] = {}
    api_key = ""
    model_ids: list[str] = []

    def add_model(value: Any) -> None:
        model_id = str(value or "").strip()
        if model_id and model_id not in model_ids:
            model_ids.append(model_id)

    if app_type in {"claude", "claude-desktop"}:
        env = settings.get("env")
        env = env if isinstance(env, dict) else {}
        parsed = {
            "base_url": env.get("ANTHROPIC_BASE_URL"),
            "wire_api": "messages",
        }
        api_key = str(
            env.get("ANTHROPIC_AUTH_TOKEN")
            or env.get("ANTHROPIC_API_KEY")
            or ""
        ).strip()
        for key in (
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
        ):
            add_model(env.get(key))
    elif app_type == "codex":
        parsed = _parse_cc_switch_toml(str(settings.get("config") or ""))
        auth = settings.get("auth")
        if isinstance(auth, dict):
            api_key = str(auth.get("OPENAI_API_KEY") or "").strip()
        catalog = settings.get("modelCatalog")
        if isinstance(catalog, dict):
            for item in catalog.get("models") or []:
                if isinstance(item, dict) and item.get("model"):
                    add_model(item["model"])
        if parsed.get("model") and parsed["model"] not in model_ids:
            model_ids.insert(0, parsed["model"])
    elif app_type == "gemini":
        env = settings.get("env")
        env = env if isinstance(env, dict) else {}
        parsed = {
            "base_url": (
                env.get("GEMINI_API_BASE_URL")
                or env.get("GOOGLE_GEMINI_BASE_URL")
                or env.get("GOOGLE_API_BASE_URL")
            ),
            "wire_api": "gemini",
        }
        api_key = str(
            env.get("GEMINI_API_KEY")
            or env.get("GOOGLE_API_KEY")
            or ""
        ).strip()
        add_model(env.get("GEMINI_MODEL"))
    elif app_type == "hermes":
        parsed = {
            "base_url": settings.get("base_url"),
            "wire_api": settings.get("api_mode") or "chat_completions",
        }
        api_key = str(settings.get("api_key") or "").strip()
        add_model(settings.get("model"))
    elif app_type == "openclaw":
        parsed = {
            "base_url": settings.get("baseUrl"),
            "wire_api": settings.get("api") or "chat_completions",
        }
        api_key = str(settings.get("apiKey") or "").strip()
        for item in settings.get("models") or []:
            if isinstance(item, dict):
                add_model(item.get("id"))
    elif app_type == "opencode":
        options = settings.get("options")
        options = options if isinstance(options, dict) else {}
        npm = str(settings.get("npm") or "")
        parsed = {
            "base_url": options.get("baseURL") or options.get("base_url"),
            "wire_api": "messages" if "anthropic" in npm else "chat_completions",
        }
        api_key = str(options.get("apiKey") or options.get("api_key") or "").strip()
        models = settings.get("models")
        if isinstance(models, dict):
            for model_id in models:
                add_model(model_id)
    else:
        options = settings.get("options")
        options = options if isinstance(options, dict) else {}
        env = settings.get("env")
        env = env if isinstance(env, dict) else {}
        parsed = {
            "base_url": (
                settings.get("base_url")
                or settings.get("baseUrl")
                or options.get("baseURL")
                or env.get("API_BASE_URL")
            ),
            "wire_api": settings.get("api_mode") or settings.get("api") or "",
        }
        api_key = str(
            settings.get("api_key")
            or settings.get("apiKey")
            or options.get("apiKey")
            or env.get("API_KEY")
            or ""
        ).strip()
        add_model(settings.get("model"))
    base_url = str(
        parsed.get("base_url")
        or CC_SWITCH_DEFAULT_BASE_URLS.get(app_type)
        or ""
    ).strip().rstrip("/")
    if not name:
        return None
    anthropic_protocol = app_type in {"claude", "claude-desktop"} or (
        app_type == "opencode" and parsed.get("wire_api") == "messages"
    )
    type_id = "anthropic" if anthropic_protocol else detect_provider_type(base_url)
    error = (
        validate_provider_values(name=name, type_id=type_id, base_url=base_url)
        if base_url
        else "未找到可导入的 API 地址"
    )
    return {
        "id": str(row.get("id") or ""),
        "source_type": app_type,
        "name": name,
        "type": type_id,
        "base_url": base_url,
        "api_key": api_key,
        "has_key": bool(api_key),
        "wire_api": str(parsed.get("wire_api") or "responses"),
        "model_ids": model_ids,
        "category": str(row.get("category") or ""),
        "error": error,
    }


def scan_cc_switch_providers() -> list[dict[str, Any]]:
    """Discover every provider application type configured in cc-switch."""
    if not CC_SWITCH_DB_PATH.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        conn = sqlite3.connect(
            f"file:{CC_SWITCH_DB_PATH}?mode=ro",
            uri=True,
            timeout=2,
        )
        try:
            conn.row_factory = sqlite3.Row
            rows = [
                dict(row)
                for row in conn.execute(
                    "SELECT id, app_type, name, settings_config, category "
                    "FROM providers "
                    "ORDER BY app_type, sort_index, name"
                ).fetchall()
            ]
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.warning("Failed to read cc-switch database: %s", exc)
        return []
    candidates: list[dict[str, Any]] = []
    for row in rows:
        candidate = _cc_switch_candidate(row)
        if candidate is not None:
            candidates.append(candidate)
    return candidates


def scan_cc_switch_codex_providers() -> list[dict[str, Any]]:
    """Backward-compatible alias for scanning supported cc-switch providers."""
    return scan_cc_switch_providers()


async def fetch_models(
    provider: dict,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[EngineModel]:
    """Fetch the provider's model list using its protocol-specific path."""
    base_url = str(provider.get("base_url") or "").rstrip("/")
    provider_type = str(provider.get("type") or "custom")
    base_path = urlparse(base_url).path.rstrip("/")
    if provider_type == "anthropic" and not base_path.endswith("/v1"):
        models_url = f"{base_url}/v1/models"
    else:
        models_url = f"{base_url}/models"
    async with httpx.AsyncClient(
        headers=auth_headers(provider),
        timeout=15,
        transport=transport,
    ) as client:
        response = await client.get(models_url)
        response.raise_for_status()
        payload = response.json()

    items = payload.get("data", []) if isinstance(payload, dict) else []
    models: dict[str, EngineModel] = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        model_id = item["id"]
        label = item.get("display_name") or item.get("name") or model_id
        models[model_id] = EngineModel(
            id=model_id,
            label=str(label),
            description=(
                str(item["owned_by"])
                if item.get("owned_by") is not None
                else None
            ),
        )
    return sorted(models.values(), key=lambda item: item.label.lower())


async def test_connection(
    provider: dict,
    timeout_seconds: float = 30,
    transport: httpx.AsyncBaseTransport | None = None,
) -> EngineTestResult:
    """Probe a provider by fetching its model list with a short timeout."""
    started = time.monotonic()
    try:
        models = await asyncio.wait_for(
            fetch_models(provider, transport=transport),
            timeout=timeout_seconds,
        )
        duration_ms = int((time.monotonic() - started) * 1000)
        return EngineTestResult(
            success=True,
            message=f"连接成功，读取到 {len(models)} 个模型",
            duration_ms=duration_ms,
        )
    except asyncio.TimeoutError:
        duration_ms = int((time.monotonic() - started) * 1000)
        return EngineTestResult(
            success=False,
            message=f"测试超时（{timeout_seconds:g} 秒）",
            duration_ms=duration_ms,
        )
    except httpx.HTTPStatusError as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        return EngineTestResult(
            success=False,
            message=f"连接失败（HTTP {exc.response.status_code}）",
            duration_ms=duration_ms,
        )
    except Exception as exc:
        duration_ms = int((time.monotonic() - started) * 1000)
        return EngineTestResult(
            success=False,
            message=str(exc) or "连接失败",
            duration_ms=duration_ms,
        )
