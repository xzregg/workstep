"""Provider HTTP client, model cache, and legacy public entry points.

Protocol rules live in provider_catalog; cc-switch parsing lives in
provider_cc_switch. Existing API callers may continue importing this module.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import httpx

from engines.core.base import EngineModel, EngineTestResult
from engines.core.schema import validate_api_base_url
from services.config import config_store
from services.engine_config_rules import CLAUDE_MODEL_MAP_ALIASES, PROVIDER_PROTOCOLS
from services.provider_catalog import (
    PROTOCOL_LABELS,
    PROVIDER_TYPES,
    VALID_AUTH_STYLES,
    ProviderType,
    auth_headers,
    canonical_provider_protocol,
    default_provider_protocol,
    default_provider_protocols,
    detect_provider_type,
    get_type_meta,
    list_provider_types,
    mask_api_key,
    normalize_provider_base_url,
    normalize_provider_protocol,
    normalize_provider_protocols,
    provider_basic_url,
    provider_endpoint_url,
    provider_runtime_base_url,
    select_provider_protocol,
    validate_provider_values,
)
from services.provider_cc_switch import (
    CC_SWITCH_DEFAULT_BASE_URLS,
    _cc_switch_candidate,
    _parse_cc_switch_toml,
    scan_cc_switch_candidates,
)

CC_SWITCH_DB_PATH = Path.home() / ".cc-switch" / "cc-switch.db"


def scan_cc_switch_providers() -> list[dict[str, Any]]:
    """Discover every provider application type configured in cc-switch."""
    return scan_cc_switch_candidates(CC_SWITCH_DB_PATH)


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
