"""Global system settings stored in ~/.workstep/config.json."""

from fastapi import APIRouter, HTTPException
from typing import Literal

from pydantic import BaseModel, Field

from services.config import config_store

router = APIRouter(prefix="/api/system-settings")


class SystemSettingsRequest(BaseModel):
    user_name: str | None = Field(default=None, max_length=80)
    open_mode: bool | None = None


class ModelPriceRequest(BaseModel):
    provider_id: str | None = Field(default=None, max_length=200)
    model: str = Field(min_length=1, max_length=300)
    input_price: float = Field(ge=0)
    output_price: float = Field(ge=0)
    cache_price: float = Field(ge=0)


class ModelPricingRequest(BaseModel):
    currency: Literal["USD", "CNY"] = "USD"
    usd_to_cny_rate: float = Field(default=7.2, gt=0)
    prices: list[ModelPriceRequest] = Field(default_factory=list)


def _model_pricing_response(pricing: dict) -> dict:
    providers = []
    for provider in config_store.get_providers():
        if not provider.get("enabled", True):
            continue
        cached = config_store.get_provider_models(str(provider.get("id") or ""))
        models = []
        for item in cached.get("models", []):
            if not isinstance(item, dict) or not str(item.get("id") or "").strip():
                continue
            models.append({
                "id": str(item["id"]),
                "label": str(item.get("label") or item["id"]),
                "description": str(item.get("description") or ""),
            })
        providers.append({
            "id": str(provider.get("id") or ""),
            "name": str(provider.get("name") or provider.get("id") or ""),
            "models": models,
        })
    engine_defaults = config_store.get("engine_default_models", {})
    standalone_models = sorted({
        value.strip()
        for value in engine_defaults.values()
        if isinstance(value, str) and value.strip()
    }) if isinstance(engine_defaults, dict) else []
    return {
        **pricing,
        "providers": providers,
        "standalone_models": standalone_models,
    }


@router.get("")
async def get_system_settings():
    return {
        "user_name": config_store.get_user_name(),
        "open_mode": config_store.get_open_mode(),
        **config_store.get_device_identity(),
    }


@router.put("")
async def set_system_settings(req: SystemSettingsRequest):
    if req.user_name is not None:
        user_name = req.user_name.strip()
        if not user_name:
            raise HTTPException(status_code=400, detail="使用者名称不能为空")
        config_store.set_user_name(user_name)
    if req.open_mode is not None:
        config_store.set_open_mode(req.open_mode)
    return await get_system_settings()


@router.get("/model-pricing")
async def get_model_pricing():
    return _model_pricing_response(config_store.get_model_pricing())


@router.put("/model-pricing")
async def set_model_pricing(req: ModelPricingRequest):
    prices = []
    seen: set[tuple[str | None, str]] = set()
    for item in req.prices:
        provider_id = item.provider_id.strip() if item.provider_id else None
        model = item.model.strip()
        if not model:
            raise HTTPException(status_code=400, detail="模型名称不能为空")
        key = (provider_id, model)
        if key in seen:
            raise HTTPException(status_code=400, detail="供应商与模型组合不能重复")
        seen.add(key)
        prices.append({
            "provider_id": provider_id,
            "model": model,
            "input_price": float(item.input_price),
            "output_price": float(item.output_price),
            "cache_price": float(item.cache_price),
        })
    pricing = {
        "currency": req.currency,
        "usd_to_cny_rate": float(req.usd_to_cny_rate),
        "prices": prices,
    }
    config_store.set_model_pricing(pricing)
    return _model_pricing_response(pricing)
