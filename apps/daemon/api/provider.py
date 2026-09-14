"""Provider settings API — manage global LLM API providers."""

import asyncio
import time
import uuid
from dataclasses import asdict

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from engines.core.registry import refresh_registry
from services import providers as provider_service
from services.config import config_store, default_provider_protocol

router = APIRouter(prefix="/api/provider")


class ProviderSaveRequest(BaseModel):
    id: str = Field(default="", max_length=64)
    name: str = Field(default="", max_length=100)
    type: str = Field(default="custom", max_length=32)
    protocol: str = Field(default="", max_length=64)
    base_url: str = Field(default="", max_length=2048)
    api_key: str = Field(default="", max_length=4096)
    enabled: bool = True
    clear: dict[str, bool] = Field(default_factory=dict)
    confirmed: dict[str, bool] = Field(default_factory=dict)


class ProviderTestRequest(BaseModel):
    timeout_seconds: float = Field(default=30, ge=3, le=120)


class ProviderImportRequest(BaseModel):
    provider_ids: list[str] = Field(default_factory=list, max_length=64)


def _public_provider(provider: dict) -> dict:
    """Mask secrets before sending provider records to the frontend."""
    entry = config_store.get_provider_models(provider.get("id", ""))
    saved_models = entry.get("models") if isinstance(entry, dict) else None
    return {
        "id": provider.get("id", ""),
        "name": provider.get("name", ""),
        "type": provider.get("type", "custom"),
        "protocol": provider.get("protocol")
        or default_provider_protocol(str(provider.get("type") or "custom")),
        "base_url": provider.get("base_url", ""),
        "api_key": "",
        "has_key": bool(provider.get("api_key")),
        "enabled": bool(provider.get("enabled", True)),
        "verified": bool(provider.get("verified", False)),
        "created_at": provider.get("created_at", ""),
        "model_count": len(saved_models) if isinstance(saved_models, list) else 0,
        "models_fetched_at": (
            entry.get("fetched_at") if isinstance(entry, dict) else None
        ),
    }


def _public_candidate(candidate: dict) -> dict:
    """Mask secrets when returning cc-switch import candidates."""
    public = dict(candidate)
    public.pop("api_key", None)
    return public


def _provider_name_exists(name: str) -> bool:
    return any(
        str(item.get("name")) == name
        for item in config_store.get_providers()
    )


def _prefill_claude_model_maps(candidate: dict) -> None:
    """用首个 Claude 导入候选预填空白的引擎级档位映射。"""
    if candidate.get("source_type") not in {"claude", "claude-desktop"}:
        return
    model_map = candidate.get("model_map")
    if not isinstance(model_map, dict) or not model_map:
        return
    if not config_store.get_claude_code_config().get("model_map"):
        config_store.set_claude_code_model_map(model_map)
    sdk = config_store.get_claude_agent_sdk_config()
    if not sdk.get("model_map"):
        config_store.set_claude_agent_sdk_config(
            max_turns=str(sdk.get("max_turns") or ""),
            permission_mode=sdk.get("permission_mode") or None,
            fallback_model=str(sdk.get("fallback_model") or ""),
            model_map=model_map,
        )


def _require_provider(provider_id: str) -> dict:
    provider = config_store.get_provider(provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    return provider


@router.get("/list")
async def list_providers(project_id: str = ""):
    """Return all providers (masked) plus built-in type presets."""
    def load() -> dict:
        providers = config_store.get_providers()
        return {
            "providers": [_public_provider(item) for item in providers],
            "types": provider_service.list_provider_types(),
        }

    return await asyncio.to_thread(load)


@router.post("")
async def save_provider(req: ProviderSaveRequest):
    """Create or update a provider; API keys keep engine-style masking."""
    name = str(req.name or "").strip()
    type_id = str(req.type or "").strip().lower()
    base_url = str(req.base_url or "").strip().rstrip("/")
    protocol = str(req.protocol or "").strip() or default_provider_protocol(type_id)

    error = provider_service.validate_provider_values(
        name=name,
        type_id=type_id,
        base_url=base_url,
        protocol=protocol,
    )
    if error:
        return {"saved": False, "message": error, "provider": None}

    provider_id = str(req.id or "").strip()
    current = (
        await asyncio.to_thread(config_store.get_provider, provider_id)
        if provider_id
        else None
    )
    if provider_id and current is not None:
        pass
    elif provider_id:
        return {"saved": False, "message": "供应商不存在", "provider": None}
    else:
        current = {}
        provider_id = f"prov_{uuid.uuid4().hex[:12]}"

    clear = req.clear or {}
    api_key: str | None = None
    if clear.get("api_key"):
        api_key = ""
    elif str(req.api_key or "").strip():
        api_key = str(req.api_key).strip()
    elif current.get("api_key"):
        api_key = current["api_key"]

    provider = {
        "id": provider_id,
        "name": name,
        "type": type_id,
        "protocol": protocol,
        "base_url": base_url,
        "api_key": api_key or "",
        "enabled": bool(req.enabled),
        "verified": bool(current.get("verified", False)),
        "created_at": current.get("created_at") or time.strftime(
            "%Y-%m-%dT%H:%M:%S"
        ),
    }
    def save() -> dict:
        config_store.save_provider(provider)
        config_store.set_engine_verified(f"provider:{provider_id}", False)
        refresh_registry()
        return _public_provider(provider)

    public_provider = await asyncio.to_thread(save)
    return {
        "saved": True,
        "message": "供应商已保存",
        "provider": public_provider,
    }


@router.get("/import/sources")
async def import_sources():
    """Discover third-party sources that can feed providers into WorkStep."""
    candidates = await asyncio.to_thread(lambda: [
        candidate
        for candidate in provider_service.scan_cc_switch_providers()
        if candidate.get("base_url")
    ])
    existing_names = await asyncio.to_thread(
        lambda: {str(item.get("name")) for item in config_store.get_providers()}
    )
    sources = []
    if candidates:
        sources.append({
            "id": "cc-switch",
            "name": "cc-switch",
            "provider_count": len(candidates),
            "description": f"发现 {len(candidates)} 个 CC Switch 供应商配置",
            "providers": [
                {
                    **_public_candidate(candidate),
                    "already_exists": candidate["name"] in existing_names,
                }
                for candidate in candidates
            ],
        })
    return {"sources": sources}


@router.post("/import/cc-switch")
async def import_cc_switch(req: ProviderImportRequest):
    """Import selected CC Switch provider configurations into WorkStep."""
    candidates, existing_names = await asyncio.to_thread(
        lambda: (
            {
                item["id"]: item
                for item in provider_service.scan_cc_switch_providers()
            },
            {str(item.get("name")) for item in config_store.get_providers()},
        )
    )
    imported: list[dict] = []
    skipped: list[dict] = []
    errors: list[dict] = []
    for provider_id in req.provider_ids:
        candidate = candidates.get(provider_id)
        if candidate is None:
            errors.append({
                "id": provider_id,
                "name": "",
                "message": "未找到该供应商",
            })
            continue
        name = candidate["name"]
        if candidate.get("error"):
            errors.append({
                "id": provider_id,
                "name": name,
                "message": candidate["error"],
            })
            continue
        if name in existing_names:
            skipped.append({
                "id": provider_id,
                "name": name,
                "message": "已存在同名供应商",
            })
            continue
        provider = {
            "id": f"prov_{uuid.uuid4().hex[:12]}",
            "name": name,
            "type": candidate["type"],
            "protocol": candidate["protocol"],
            "base_url": candidate["base_url"],
            "api_key": candidate["api_key"] or "",
            "enabled": True,
            "verified": False,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        public_provider = await asyncio.to_thread(
            lambda: (
                config_store.save_provider(provider),
                _prefill_claude_model_maps(candidate),
                _public_provider(provider),
            )[2]
        )
        existing_names.add(name)
        imported.append(public_provider)
    if imported:
        await asyncio.to_thread(refresh_registry)
    return {
        "source": "cc-switch",
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
    }


@router.delete("/{provider_id}")
async def delete_provider(provider_id: str):
    """Delete a provider; refuse while an engine still references it."""
    provider = await asyncio.to_thread(config_store.get_provider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    if await asyncio.to_thread(config_store.is_provider_in_use, provider_id):
        raise HTTPException(
            status_code=400,
            detail="该供应商正被引擎或助手使用，请先切换其它供应商",
        )
    def delete() -> None:
        config_store.delete_provider(provider_id)
        config_store.clear_provider_models(provider_id)
        config_store.set_engine_verified(f"provider:{provider_id}", False)
        refresh_registry()

    await asyncio.to_thread(delete)
    return {"deleted": True}


@router.post("/{provider_id}/test")
async def test_provider(provider_id: str, req: ProviderTestRequest):
    """Probe connectivity by fetching the provider's model list."""
    provider = await asyncio.to_thread(_require_provider, provider_id)
    result = await provider_service.test_connection(
        provider,
        timeout_seconds=req.timeout_seconds,
    )
    await asyncio.to_thread(
        lambda: (
            config_store.save_provider({**provider, "verified": result.success}),
            refresh_registry(),
        )
    )
    return {
        "provider_id": provider_id,
        **asdict(result),
    }


@router.get("/{provider_id}/models")
async def provider_models(provider_id: str, refresh: bool = False):
    """Return the provider's selectable models.

    Defaults to the locally saved copy; ``refresh=1`` re-fetches from the
    provider address and saves the result.
    """
    provider, entry = await asyncio.to_thread(
        lambda: (
            _require_provider(provider_id),
            config_store.get_provider_models(provider_id),
        )
    )
    if not refresh:
        return {
            "provider_id": provider_id,
            "models": (
                [
                    asdict(model)
                    for model in await asyncio.to_thread(
                        provider_service.saved_models, provider_id
                    )
                ]
                if entry
                else []
            ),
            "fetched_at": entry.get("fetched_at") if entry else None,
            "error": None,
        }
    try:
        models = await asyncio.wait_for(
            provider_service.fetch_and_save_models(provider),
            timeout=15,
        )
        error = None
    except asyncio.TimeoutError:
        models = []
        error = "读取模型列表超时"
    except Exception as exc:
        models = []
        error = str(exc) or "读取模型列表失败"
    return {
        "provider_id": provider_id,
        "models": [asdict(model) for model in models],
        "fetched_at": (
            await asyncio.to_thread(config_store.get_provider_models, provider_id)
        ).get("fetched_at"),
        "error": error,
    }


@router.get("/{provider_id}/balance")
async def provider_balance(provider_id: str):
    """Query provider quota/balance (placeholder — phase 2)."""
    await asyncio.to_thread(_require_provider, provider_id)
    return {
        "provider_id": provider_id,
        "supported": False,
        "balance": None,
        "message": "额度查询将在后续版本支持",
    }


@router.post("/{provider_id}/reveal")
async def reveal_provider_key(provider_id: str):
    """Return the stored API key after an explicit reveal action."""
    provider = await asyncio.to_thread(_require_provider, provider_id)
    return JSONResponse(
        {"key": "api_key", "value": provider.get("api_key") or None},
        headers={"Cache-Control": "no-store"},
    )
