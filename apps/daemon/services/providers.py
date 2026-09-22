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
from services.config import (
    CLAUDE_MODEL_MAP_ALIASES,
    PROVIDER_PROTOCOLS,
    config_store,
    default_provider_protocol,
    default_provider_protocols,
)

logger = logging.getLogger(__name__)

CC_SWITCH_DB_PATH = Path.home() / ".cc-switch" / "cc-switch.db"


@dataclass(frozen=True)
class ProviderType:
    id: str
    label: str
    default_base_url: str
    auth: str  # bearer | anthropic | none
    default_protocols: tuple[str, ...]
    supports_balance: bool = False
    help: str = ""

    @property
    def default_protocol(self) -> str:
        """Backward-compatible single protocol (first of the list)."""
        return self.default_protocols[0]


PROVIDER_TYPES: dict[str, ProviderType] = {
    "deepseek": ProviderType(
        id="deepseek",
        label="DeepSeek",
        default_base_url="https://api.deepseek.com/v1",
        auth="bearer",
        default_protocols=("openai_chat_completions",),
        help="DeepSeek 官方 OpenAI-compatible 接口",
    ),
    "moonshot": ProviderType(
        id="moonshot",
        label="Kimi（Moonshot）",
        default_base_url="https://api.moonshot.cn/v1",
        auth="bearer",
        default_protocols=("openai_chat_completions",),
        help="Moonshot Kimi OpenAI-compatible 接口",
    ),
    "openai": ProviderType(
        id="openai",
        label="OpenAI",
        default_base_url="https://api.openai.com/v1",
        auth="bearer",
        default_protocols=("openai_responses", "openai_chat_completions"),
        help="OpenAI 官方接口",
    ),
    "anthropic": ProviderType(
        id="anthropic",
        label="Anthropic",
        default_base_url="https://api.anthropic.com/v1",
        auth="anthropic",
        default_protocols=("anthropic_messages",),
        help="Anthropic Messages API（x-api-key 鉴权）",
    ),
    "ollama": ProviderType(
        id="ollama",
        label="Ollama（本地）",
        default_base_url="http://localhost:11434/v1",
        auth="none",
        default_protocols=("openai_chat_completions",),
        help="本地模型运行器，API Key 可留空",
    ),
    "custom": ProviderType(
        id="custom",
        label="自定义",
        default_base_url="",
        auth="bearer",
        default_protocols=("openai_chat_completions", "openai_responses"),
        help="任意 OpenAI-compatible 或 Anthropic-compatible 接口",
    ),
}

VALID_AUTH_STYLES = {"bearer", "anthropic", "none"}

PROTOCOL_LABELS = {
    "anthropic_messages": "Anthropic Messages",
    "openai_responses": "OpenAI Responses",
    "openai_chat_completions": "OpenAI Chat Completions",
}

CC_SWITCH_DEFAULT_BASE_URLS = {
    "codex": "https://api.openai.com/v1",
    "claude": "https://api.anthropic.com/v1",
    "claude-desktop": "https://api.anthropic.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
}


def get_type_meta(type_id: str) -> ProviderType | None:
    return PROVIDER_TYPES.get(type_id)


def list_provider_types() -> list[dict]:
    result: list[dict] = []
    for item in PROVIDER_TYPES.values():
        data = asdict(item)
        data["default_protocol"] = item.default_protocol
        result.append(data)
    return result


def mask_api_key(api_key: str) -> str:
    """Mask a secret key, keeping only a short prefix and suffix."""
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "****"
    return f"{api_key[:4]}****{api_key[-4:]}"


def auth_headers(provider: dict, protocol: str | None = None) -> dict[str, str]:
    """Build per-provider auth headers for OpenAI-compatible / Anthropic calls.

    ``protocol`` 指定本次调用使用的线协议（缺省取供应商默认协议）：
    Anthropic 协议用 x-api-key 头，其余用 Bearer。
    """
    provider_type = get_type_meta(str(provider.get("type") or "custom"))
    auth = provider_type.auth if provider_type else "bearer"
    selected = str(protocol or "").strip()
    if not selected:
        selected = (
            normalize_provider_protocols(
                provider.get("protocols") or provider.get("protocol"),
                str(provider.get("type") or "custom"),
            )
            or [""]
        )[0]
    if selected == "anthropic_messages":
        auth = "anthropic"
    elif selected in {"openai_responses", "openai_chat_completions"}:
        auth = "none" if auth == "none" else "bearer"
    api_key = str(provider.get("api_key") or "")
    if auth == "anthropic":
        headers = {"anthropic-version": "2023-06-01", "Accept": "application/json"}
        if api_key:
            headers["x-api-key"] = api_key
        return headers
    if auth == "bearer" and api_key:
        return {"Accept": "application/json", "Authorization": f"Bearer {api_key}"}
    return {"Accept": "application/json"}


def normalize_provider_base_url(base_url: str) -> str:
    """Normalize an API base without guessing or changing its version path."""
    return str(base_url or "").strip().rstrip("/")


def provider_basic_url(provider: dict, protocol: str) -> str:
    """Return the basic URL configured for one protocol, with legacy fallback."""
    mapping = provider.get("protocol_base_urls")
    configured = mapping.get(protocol) if isinstance(mapping, dict) else ""
    return normalize_provider_base_url(
        str(configured or provider.get("base_url") or "")
    )


def provider_runtime_base_url(provider: dict, protocol: str) -> str:
    """Return the configured protocol API base unchanged."""
    return provider_basic_url(provider, protocol)


def provider_endpoint_url(provider: dict, protocol: str, endpoint: str) -> str:
    """Build a direct HTTP endpoint from a protocol-specific basic URL."""
    basic = provider_basic_url(provider, protocol)
    suffix = str(endpoint or "").strip("/")
    return f"{basic}/{suffix}" if suffix else basic


def validate_provider_values(
    *,
    name: str,
    type_id: str,
    base_url: str,
    protocols: list[str] | None = None,
    protocol_base_urls: dict[str, str] | None = None,
) -> str | None:
    """Validate provider form values; return an error message or None."""
    if not name:
        return "供应商名称不能为空"
    provider_type = get_type_meta(type_id)
    if provider_type is None:
        return "不支持的供应商类型"
    if protocols is not None:
        if not protocols:
            return "至少选择一个供应商协议"
        for value in protocols:
            if value not in PROVIDER_PROTOCOLS:
                return "不支持的供应商协议"
    if protocols and protocol_base_urls is not None:
        for protocol in protocols:
            configured = str(protocol_base_urls.get(protocol) or "").strip()
            if not configured:
                return f"{PROTOCOL_LABELS.get(protocol, protocol)} API 地址不能为空"
            url_error = validate_api_base_url(configured)
            if url_error:
                return f"{PROTOCOL_LABELS.get(protocol, protocol)}：{url_error}"
    else:
        if not base_url:
            return "API 地址不能为空"
        url_error = validate_api_base_url(base_url)
        if url_error:
            return url_error
    return None


def canonical_provider_protocol(value: str) -> str:
    aliases = {
        "messages": "anthropic_messages",
        "anthropic": "anthropic_messages",
        "responses": "openai_responses",
        "chat": "openai_chat_completions",
        "chat_completions": "openai_chat_completions",
        "openai-completions": "openai_chat_completions",
    }
    raw = str(value or "").strip()
    return aliases.get(raw, raw)


def normalize_provider_protocol(value: str, type_id: str = "custom") -> str:
    normalized = canonical_provider_protocol(value)
    return (
        normalized
        if normalized in PROVIDER_PROTOCOLS
        else default_provider_protocol(type_id)
    )


def normalize_provider_protocols(
    values: Any, type_id: str = "custom"
) -> list[str]:
    """把任意输入规范化为去重、保序的协议列表。

    入参可以是列表、单个字符串或 None（空值回退到该供应商类型的默认
    协议列表）；每个值经 ``normalize_provider_protocol`` 处理别名后去重。
    """
    if values is None:
        raw_items: list[Any] = []
    elif isinstance(values, str):
        raw_items = [values]
    elif isinstance(values, (list, tuple, set)):
        raw_items = list(values)
    else:
        raw_items = [values]
    fallback = (
        list(get_type_meta(type_id).default_protocols)
        if get_type_meta(type_id) is not None
        else default_provider_protocols(type_id)
    )
    result: list[str] = []
    for value in raw_items:
        # 单值语义与 normalize_provider_protocol 一致：非法值回退类型默认。
        normalized = normalize_provider_protocol(str(value), type_id)
        if normalized not in result:
            result.append(normalized)
    return result or fallback


def select_provider_protocol(provider: dict, protocol: str | None = None) -> str:
    """Resolve one declared protocol, rejecting unsupported explicit choices."""
    provider_type = str(provider.get("type") or "custom")
    declared = normalize_provider_protocols(
        provider.get("protocols") or provider.get("protocol"), provider_type
    )
    requested = canonical_provider_protocol(str(protocol or ""))
    if requested:
        if requested not in PROVIDER_PROTOCOLS or requested not in declared:
            raise ValueError("所选协议未在该供应商中配置")
        return requested
    return declared[0]


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
    model_map: dict[str, dict[str, str]] = {}

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
        for alias in CLAUDE_MODEL_MAP_ALIASES:
            key = f"ANTHROPIC_DEFAULT_{alias.upper()}_MODEL"
            model = str(env.get(key) or "").strip()
            if not model:
                continue
            display_name = str(env.get(f"{key}_NAME") or "").strip() or model
            model_map[alias] = {"model": model, "name": display_name}
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
    wire_api = str(
        parsed.get("wire_api")
        or ("responses" if app_type == "codex" else "")
    )
    protocol = normalize_provider_protocol(wire_api, type_id)
    return {
        "id": str(row.get("id") or ""),
        "source_type": app_type,
        "name": name,
        "type": type_id,
        "protocol": protocol,
        "protocols": [protocol],
        "base_url": base_url,
        "api_key": api_key,
        "has_key": bool(api_key),
        "wire_api": wire_api or "responses",
        "model_ids": model_ids,
        "model_map": model_map,
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
    protocol: str | None = None,
) -> list[EngineModel]:
    """Fetch the provider's model list using its protocol-specific path.

    ``protocol`` 指定按哪种线协议解析地址（缺省取供应商默认协议）。
    """
    protocol = select_provider_protocol(provider, protocol)
    models_url = provider_endpoint_url(provider, protocol, "models")
    async with httpx.AsyncClient(
        headers=auth_headers(provider, protocol),
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


def saved_models(provider_id: str, protocol: str = "") -> list[EngineModel]:
    """Return the locally saved model list for a provider (no network call)."""
    from dataclasses import fields as dataclass_fields

    entry = config_store.get_provider_models(provider_id, protocol)
    raw_models = entry.get("models") or []
    result: list[EngineModel] = []
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        try:
            result.append(EngineModel(**{
                field.name: item.get(field.name)
                for field in dataclass_fields(EngineModel)
            }))
        except TypeError:
            continue
    return result


def save_models(
    provider: dict, models: list[EngineModel], protocol: str = ""
) -> None:
    """Persist a provider's model list in the global config (no per-project DB)."""
    from dataclasses import asdict
    from datetime import datetime, timezone

    config_store.set_provider_models(
        str(provider.get("id") or ""),
        [asdict(model) for model in models],
        datetime.now(timezone.utc).isoformat(timespec="seconds"),
        protocol,
    )


async def fetch_and_save_models(
    provider: dict, protocol: str | None = None
) -> list[EngineModel]:
    """Fetch a provider's model list once and persist it locally."""
    selected = select_provider_protocol(provider, protocol)
    models = await fetch_models(provider, protocol=selected)
    await asyncio.to_thread(save_models, provider, models, selected)
    return models


async def chat_completion(
    provider: dict,
    model: str,
    messages: list[dict[str, str]],
    *,
    max_tokens: int = 4096,
    timeout: float = 60,
    transport: httpx.AsyncBaseTransport | None = None,
    thinking: str | None = None,
    protocol: str | None = None,
) -> str:
    """One-shot OpenAI-compatible ``/chat/completions`` call (no agent machinery).

    Used by lightweight helpers like prompt enhancement: plain single-turn
    completion against the provider's chat/completions endpoint. ``thinking``
    accepts ``"disabled"`` to turn off reasoning on models that support it
    (e.g. DeepSeek); providers that reject the field fall back to a plain call.
    """
    model = (model or "").strip()
    has_base_url = bool(
        provider.get("base_url") or provider.get("protocol_base_urls")
    )
    if not has_base_url or not model:
        raise ValueError("供应商或模型未配置")
    protocols = normalize_provider_protocols(
        provider.get("protocols") or provider.get("protocol"),
        str(provider.get("type") or "custom"),
    )
    if "openai_chat_completions" not in protocols:
        raise ValueError("该供应商不支持 chat/completions 直连")
    selected = select_provider_protocol(
        provider, protocol or "openai_chat_completions"
    )
    if selected != "openai_chat_completions":
        raise ValueError("该供应商不支持 chat/completions 直连")
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": False,
    }
    if thinking:
        payload["thinking"] = {"type": thinking}
    url = provider_endpoint_url(provider, selected, "chat/completions")
    async with httpx.AsyncClient(
        headers=auth_headers(provider, selected),
        timeout=timeout,
        transport=transport,
    ) as client:
        response = await client.post(url, json=payload)
        if response.status_code in (400, 422) and "thinking" in payload:
            # 供应商不支持 thinking 参数：去掉后重试一次。
            payload.pop("thinking", None)
            response = await client.post(url, json=payload)
        response.raise_for_status()
        data = response.json()
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"chat/completions 响应格式异常：{data}") from exc
    content = str(content or "")
    if not content:
        raise RuntimeError("模型未返回内容，请重试")
    return content


def _responses_text(data: Any) -> str:
    """Extract assistant text from an OpenAI Responses payload."""
    if not isinstance(data, dict):
        return ""
    direct = data.get("output_text")
    if isinstance(direct, str) and direct:
        return direct
    parts: list[str] = []
    for output in data.get("output", []):
        if not isinstance(output, dict):
            continue
        for item in output.get("content", []):
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if item.get("type") in {"output_text", "text"} and isinstance(text, str):
                parts.append(text)
    return "".join(parts)


async def text_completion(
    provider: dict,
    model: str,
    messages: list[dict[str, str]],
    *,
    max_tokens: int = 4096,
    timeout: float = 60,
    transport: httpx.AsyncBaseTransport | None = None,
    thinking: str | None = None,
    protocol: str | None = None,
) -> str:
    """Run a one-shot text request through any configured provider protocol."""
    model = (model or "").strip()
    has_base_url = bool(
        provider.get("base_url") or provider.get("protocol_base_urls")
    )
    if not has_base_url or not model:
        raise ValueError("供应商或模型未配置")
    selected = select_provider_protocol(provider, protocol)
    if selected == "openai_chat_completions":
        return await chat_completion(
            provider,
            model,
            messages,
            max_tokens=max_tokens,
            timeout=timeout,
            transport=transport,
            thinking=thinking,
            protocol=selected,
        )

    if selected == "anthropic_messages":
        system_parts = [
            str(item.get("content") or "")
            for item in messages
            if item.get("role") == "system" and item.get("content")
        ]
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "stream": False,
            "messages": [
                {"role": item["role"], "content": item.get("content") or ""}
                for item in messages
                if item.get("role") in {"user", "assistant"}
            ],
        }
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)
        endpoint = "messages"
    elif selected == "openai_responses":
        payload = {
            "model": model,
            "input": messages,
            "max_output_tokens": max_tokens,
            "stream": False,
        }
        endpoint = "responses"
    else:
        raise ValueError("该供应商协议不支持单轮文本调用")

    url = provider_endpoint_url(provider, selected, endpoint)
    async with httpx.AsyncClient(
        headers=auth_headers(provider, selected),
        timeout=timeout,
        transport=transport,
    ) as client:
        response = await client.post(url, json=payload)
        response.raise_for_status()
        data = response.json()

    if selected == "anthropic_messages":
        content = data.get("content", []) if isinstance(data, dict) else []
        result = "".join(
            str(item.get("text") or "")
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
        )
    else:
        result = _responses_text(data)
    if not result:
        raise RuntimeError("模型未返回内容，请重试")
    return result


async def test_connection(
    provider: dict,
    timeout_seconds: float = 30,
    transport: httpx.AsyncBaseTransport | None = None,
    protocol: str | None = None,
) -> EngineTestResult:
    """Probe a provider by fetching its model list with a short timeout.

    ``protocol`` 指定按哪种线协议探测（缺省取供应商默认协议）。
    """
    started = time.monotonic()
    try:
        models = await asyncio.wait_for(
            fetch_models(provider, transport=transport, protocol=protocol),
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
