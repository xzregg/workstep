"""Assistant registry settings API — per-assistant default engine/model."""

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from agent_assistants.base import assistant_registry
from engines.core.registry import create_engine, get_available_engines
from services.config import CODEX_REASONING_EFFORTS, config_store

router = APIRouter(prefix="/api/assistant")

# All assistants expose the same settings fields. Each assistant's defaults
# fall back to the coordinator defaults and are overridden per assistant
# (see ``config_store.get_assistant_defaults`` / ``set_assistant_defaults``).
ASSISTANT_FIELDS: tuple[str, ...] = (
    "engine",
    "model",
    "fast_model",
    "vision_model",
    "thinking_effort",
    "provider_id",
)


class EnhanceConfigRequest(BaseModel):
    provider_id: str = Field(default="", max_length=200)
    model: str = Field(default="", max_length=200)


class ConcurrencyConfigRequest(BaseModel):
    max_tasks: int = Field(default=0, ge=0)
    max_chats: int = Field(default=0, ge=0)
    schedule_exempt: bool = False


class AssistantConfigRequest(BaseModel):
    engine: str = Field(default="", max_length=100)
    model: str = Field(default="", max_length=200)
    fast_model: str = Field(default="", max_length=200)
    vision_model: str = Field(default="", max_length=200)
    thinking_effort: str = Field(default="", max_length=20)
    provider_id: str = Field(default="", max_length=200)


def _available_engines() -> list[dict]:
    return [
        item
        for item in get_available_engines()
        if item.get("installed")
        and (
            item.get("supports_coordinator")
            or item.get("id") == "pydantic_ai"
        )
    ]


@router.get("/list")
async def list_assistants():
    def load() -> dict:
        available = _available_engines()
        assistants = []
        for config in assistant_registry.all():
            fields = list(ASSISTANT_FIELDS)
            configured = config_store.get_assistant_defaults(config.name)
            assistants.append(
                {
                    "name": config.name,
                    "channel": config.channel,
                    "scope": config.scope,
                    "engine_label": config.engine_label,
                    "fields": list(fields),
                    "configured": {key: configured.get(key, "") for key in fields},
                    "available_engines": available,
                }
            )
        return {"assistants": assistants}

    return await asyncio.to_thread(load)


@router.get("/enhance-config")
async def get_enhance_config():
    """Return the prompt enhancement provider + model (agent assistant settings)."""
    def load() -> dict:
        config = config_store.get_prompt_enhance_config()
        providers = [
            {
                "id": item["id"],
                "name": item.get("name") or item["id"],
                "type": item.get("type") or "custom",
                "base_url": item.get("base_url") or "",
                "enabled": bool(item.get("enabled", True)),
            }
            for item in config_store.get_providers()
        ]
        return {
            "provider_id": config["provider_id"],
            "model": config["model"],
            "providers": providers,
        }

    return await asyncio.to_thread(load)


@router.put("/enhance-config")
async def set_enhance_config(req: EnhanceConfigRequest):
    """Save the prompt enhancement provider + model (empty clears)."""
    provider_id = req.provider_id.strip()
    model = req.model.strip()
    if provider_id or model:
        if not provider_id or not model:
            raise HTTPException(status_code=400, detail="供应商与模型需同时填写")
        provider = await asyncio.to_thread(config_store.get_provider, provider_id)
        if provider is None:
            raise HTTPException(status_code=404, detail=f"供应商不存在：{provider_id}")
        if str(provider.get("type") or "") == "anthropic":
            raise HTTPException(status_code=400, detail="该供应商类型不支持 chat/completions 直连")
    def save() -> dict:
        config_store.set_prompt_enhance_config(provider_id=provider_id, model=model)
        return {"saved": True, **config_store.get_prompt_enhance_config()}

    return await asyncio.to_thread(save)


@router.get("/concurrency")
async def get_concurrency_config():
    """Return the global task/chat concurrency defaults (0 = unlimited)."""
    config = await asyncio.to_thread(config_store.get_concurrency_config)
    return {"saved": True, **config}


@router.put("/concurrency")
async def set_concurrency_config(req: ConcurrencyConfigRequest):
    """Save global concurrency defaults and refresh the in-memory gate."""
    def save() -> dict:
        config_store.set_concurrency_config(
            max_tasks=req.max_tasks,
            max_chats=req.max_chats,
            schedule_exempt=req.schedule_exempt,
        )
        return config_store.get_concurrency_config()

    saved = await asyncio.to_thread(save)
    from services.concurrency import concurrency_gate

    concurrency_gate.configure(**saved)
    return {"saved": True, **saved}


@router.put("/{name}/config")
async def set_assistant_config(name: str, req: AssistantConfigRequest):
    config = assistant_registry.get(name)
    if config is None:
        raise HTTPException(status_code=404, detail=f"Assistant not found: {name}")
    engine = req.engine.strip()
    model = req.model.strip()
    fast_model = req.fast_model.strip()
    vision_model = req.vision_model.strip()
    thinking_effort = req.thinking_effort.strip()
    provider_id = req.provider_id.strip()
    if thinking_effort and thinking_effort not in CODEX_REASONING_EFFORTS:
        raise HTTPException(status_code=400, detail="不支持的思考强度")
    if engine:
        candidate = await asyncio.to_thread(create_engine, engine)
        if candidate is None or not (
            candidate.capabilities.supports_coordinator
            or engine == "pydantic_ai"
        ):
            raise HTTPException(status_code=400, detail=f"助手引擎不可用：{engine}")
    elif model or fast_model or vision_model:
        raise HTTPException(status_code=400, detail="默认模型需要先选择引擎")
    if provider_id:
        provider = await asyncio.to_thread(config_store.get_provider, provider_id)
        if provider is None:
            raise HTTPException(status_code=404, detail=f"供应商不存在：{provider_id}")
        if not provider.get("enabled", True):
            raise HTTPException(status_code=400, detail="所选供应商已停用")
        candidate = await asyncio.to_thread(create_engine, engine) if engine else None
        if candidate is None or not candidate.supports_provider(provider):
            raise HTTPException(status_code=400, detail="供应商协议与助手引擎不兼容")
    def save() -> dict:
        config_store.set_assistant_defaults(
            name,
            engine,
            model,
            fast_model,
            vision_model,
            thinking_effort,
            provider_id,
        )
        return config_store.get_assistant_defaults(name)

    saved = await asyncio.to_thread(save)
    return {
        "saved": True,
        "configured": {key: saved.get(key, "") for key in ASSISTANT_FIELDS},
    }
