"""LLM engine discovery and connectivity API."""

import asyncio
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from engines.core.base import BaseLLMEngine
from engines.core.registry import (
    create_engine,
    get_available_engines,
    list_all_engines,
    refresh_registry,
)
from services.config import (
    CODEX_REASONING_EFFORTS,
    DEFAULT_EXECUTION_ENGINE,
    config_store,
)
from services.project import project_manager

router = APIRouter(prefix="/api/engine")


class EngineTestRequest(BaseModel):
    engine_id: str = Field(min_length=1)
    timeout_seconds: float = Field(default=30, ge=3, le=120)


class DefaultModelRequest(BaseModel):
    model: str = Field(default="", max_length=200)


class DefaultEngineRequest(BaseModel):
    engine: str = Field(default="", max_length=100)


class CoordinatorDefaultsRequest(BaseModel):
    engine: str = Field(default="", max_length=100)
    model: str = Field(default="", max_length=200)
    fast_model: str = Field(default="", max_length=200)
    vision_model: str = Field(default="", max_length=200)
    thinking_effort: str = Field(default="", max_length=20)


class BinaryPathRequest(BaseModel):
    path: str = Field(default="", max_length=4096)


class EngineConfigSaveRequest(BaseModel):
    values: dict = Field(default_factory=dict)
    clear: dict[str, bool] = Field(default_factory=dict)
    confirmed: dict[str, bool] = Field(default_factory=dict)


class EngineConfigRevealRequest(BaseModel):
    key: str = Field(min_length=1, max_length=200)


@router.get("/list")
async def list_engines():
    """Return every supported backend and its local availability."""
    return {"engines": get_available_engines()}


@router.post("/refresh")
async def refresh_engines():
    """Re-scan the host for supported execution engines."""
    refresh_registry()
    return {"engines": get_available_engines()}


def _coordinator_engine_options() -> list[dict]:
    return [
        item
        for item in get_available_engines()
        if item.get("installed")
        and (
            item.get("supports_coordinator")
            or item.get("id") == "pydantic_ai"
        )
    ]


def _validate_engine(engine_id: str, *, coordinator: bool = False):
    engine = create_engine(engine_id)
    if engine is None or not engine.is_configured():
        raise HTTPException(status_code=400, detail="引擎未安装或尚未配置")
    if coordinator and not engine.capabilities.supports_coordinator:
        raise HTTPException(status_code=400, detail="该引擎不支持协调模式")
    if not config_store.is_engine_verified(engine_id):
        raise HTTPException(status_code=400, detail="请先在设置中完成引擎测试")
    return engine


@router.get("/execution/config")
async def get_execution_default_config():
    configured = config_store.get_execution_default_engine()
    return {
        "engine": configured,
        "resolved_engine": configured or DEFAULT_EXECUTION_ENGINE,
    }


@router.put("/execution/config")
async def set_execution_default_config(req: DefaultEngineRequest):
    engine_id = req.engine.strip()
    if engine_id:
        _validate_engine(engine_id)
    config_store.set_execution_default_engine(engine_id)
    return {
        "saved": True,
        "engine": engine_id,
        "resolved_engine": engine_id or DEFAULT_EXECUTION_ENGINE,
    }


@router.get("/coordinator/config")
async def get_coordinator_default_config(project_id: str = ""):
    return {
        "engine": config_store.get_coordinator_default_engine(),
        "model": config_store.get_coordinator_default_model(),
        "fast_model": config_store.get_coordinator_default_fast_model(),
        "vision_model": config_store.get_coordinator_default_vision_model(),
        "thinking_effort": config_store.get_coordinator_default_thinking_effort(),
        "available_engines": _coordinator_engine_options(),
    }


@router.put("/coordinator/config")
async def set_coordinator_default_config(req: CoordinatorDefaultsRequest):
    engine_id = req.engine.strip()
    model = req.model.strip()
    fast_model = req.fast_model.strip()
    vision_model = req.vision_model.strip()
    thinking_effort = req.thinking_effort.strip()
    if thinking_effort and thinking_effort not in CODEX_REASONING_EFFORTS:
        raise HTTPException(status_code=400, detail="不支持的思考强度")
    if engine_id:
        _validate_engine(engine_id, coordinator=True)
    elif model or fast_model or vision_model:
        raise HTTPException(status_code=400, detail="默认模型需要先选择协调引擎")
    config_store.set_coordinator_defaults(
        engine_id, model, fast_model, vision_model, thinking_effort
    )
    return {
        "saved": True,
        "engine": engine_id,
        "model": model,
        "fast_model": fast_model,
        "vision_model": vision_model,
        "thinking_effort": thinking_effort,
    }


@router.post("/test")
async def test_engine(req: EngineTestRequest):
    """Delegate the connectivity test to the selected engine adapter."""
    refresh_registry()
    engine = create_engine(req.engine_id)
    if engine is None:
        config_store.set_engine_verified(req.engine_id, False)
        return {
            "engine_id": req.engine_id,
            "success": False,
            "message": "引擎未安装或当前不可用",
            "duration_ms": 0,
        }

    result = await engine.test_connection(
        cwd=str(Path.cwd()),
        timeout_seconds=req.timeout_seconds,
    )
    config_store.set_engine_verified(req.engine_id, result.success)
    engine_info = next(
        item for item in get_available_engines()
        if item["id"] == req.engine_id
    )
    return {
        "engine_id": req.engine_id,
        **asdict(result),
        "engine": engine_info,
    }


@router.post("/{engine_id}/install")
async def install_engine(engine_id: str):
    """Install an engine's runtime (CLI binary / Python SDK) on this host."""
    cls = list_all_engines().get(engine_id)
    if cls is None:
        raise HTTPException(status_code=404, detail="未知引擎")
    engine = cls()
    if engine.is_installed():
        return {
            "engine_id": engine_id,
            "success": True,
            "already_installed": True,
            "message": "引擎已安装",
            "engine": next(
                (item for item in get_available_engines() if item["id"] == engine_id),
                None,
            ),
        }
    if engine.install_command() is None:
        raise HTTPException(
            status_code=400,
            detail="该引擎不支持自动安装，请手动安装后重新扫描",
        )
    result = await engine.install()
    engine_info = None
    if result.success:
        refresh_registry()
        engine_info = next(
            (item for item in get_available_engines() if item["id"] == engine_id),
            None,
        )
    return {
        "engine_id": engine_id,
        "success": result.success,
        "already_installed": result.already_installed,
        "message": result.message,
        "engine": engine_info,
    }


@router.get("/{engine_id}/inspect")
async def inspect_engine(
    engine_id: str,
    project_id: str = Query("", alias="project_id"),
    project_root: str = Query("", alias="project_root"),
):
    """Return what the engine loads for a project (skills / MCP servers)."""
    cls = list_all_engines().get(engine_id)
    if cls is None:
        raise HTTPException(status_code=404, detail="未知引擎")
    root = project_root.strip() or None
    if not root and project_id.strip():
        project = project_manager.get_project_by_id(project_id.strip())
        root = str(project.path) if project else None
    result = await cls().inspect_capabilities(project_root=root)
    if result is None:
        raise HTTPException(status_code=400, detail="该引擎不支持查看加载能力")
    return result


@router.get("/{engine_id}/models")
async def list_engine_models(
    engine_id: str,
    provider_id: str = "",
    refresh: bool = False,
    project_id: str = "",
):
    """Return selectable models through the engine adapter interface.

    Pydantic AI reads its saved per-provider model list by default;
    ``refresh=1`` re-fetches from the provider and saves the result.
    """
    refresh_registry(invalidate_scan=False)
    engine = create_engine(engine_id)
    if engine is None:
        return {
            "engine_id": engine_id,
            "models": [],
            "default_model": "",
            "error": "引擎未安装或当前不可用",
        }
    fetched_at = None
    try:
        project = project_manager.get_project_by_id(project_id.strip()) if project_id.strip() else None
        models_kwargs: dict = {"cwd": str(project.path) if project else str(Path.cwd())}
        if engine_id in {"pydantic_ai", "deepseek_harness"} and provider_id.strip():
            models_kwargs["provider_id"] = provider_id.strip()
        if engine_id in {"pydantic_ai", "deepseek_harness"} and refresh:
            models_kwargs["refresh"] = True
        models = await asyncio.wait_for(
            engine.list_models(**models_kwargs),
            timeout=15,
        )
        if engine_id in {"pydantic_ai", "deepseek_harness"}:
            effective_provider = (
                provider_id.strip()
                or (
                    config_store.get_pydantic_ai_engine_config()
                    if engine_id == "pydantic_ai"
                    else config_store.get_deepseek_harness_config()
                ).get("provider_id", "")
            )
            fetched_at = config_store.get_provider_models(effective_provider).get("fetched_at")
        error = None
    except asyncio.TimeoutError:
        models = []
        error = "读取模型列表超时"
    except Exception as exc:
        models = []
        error = str(exc) or "读取模型列表失败"
    return {
        "engine_id": engine_id,
        "models": [asdict(model) for model in models],
        "default_model": config_store.get_engine_default_model(engine_id),
        "fetched_at": fetched_at,
        "error": error,
    }


@router.put("/{engine_id}/default-model")
async def set_default_model(engine_id: str, req: DefaultModelRequest):
    """Persist the model inherited by stages without an explicit model."""
    refresh_registry()
    if create_engine(engine_id) is None:
        return {
            "engine_id": engine_id,
            "default_model": "",
            "saved": False,
            "message": "引擎未安装或当前不可用",
        }
    model = req.model.strip()
    config_store.set_engine_default_model(engine_id, model)
    config_store.set_engine_verified(engine_id, False)
    return {
        "engine_id": engine_id,
        "default_model": model,
        "saved": True,
    }


@router.put("/{engine_id}/binary-path")
async def set_binary_path(engine_id: str, req: BinaryPathRequest):
    """Persist or clear a backend's executable path override."""
    supported = {engine["id"] for engine in get_available_engines()}
    if engine_id not in supported or engine_id == "pydantic_ai":
        return {
            "engine_id": engine_id,
            "saved": False,
            "message": "该引擎不支持可执行文件路径配置",
        }

    raw_path = req.path.strip()
    if raw_path:
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            return {
                "engine_id": engine_id,
                "saved": False,
                "message": "请输入可执行文件的绝对路径",
            }
        if not path.is_file():
            return {
                "engine_id": engine_id,
                "saved": False,
                "message": "指定的可执行文件不存在",
            }
        normalized = str(path.resolve())
    else:
        normalized = ""

    config_store.set_engine_binary_path(engine_id, normalized)
    config_store.set_engine_verified(engine_id, False)
    refresh_registry()
    engine_info = next(
        engine for engine in get_available_engines() if engine["id"] == engine_id
    )
    return {
        "engine_id": engine_id,
        "saved": True,
        "engine": engine_info,
    }


@router.get("/{engine_id}/config")
async def get_engine_config(engine_id: str):
    """Return the engine's config schema and current values as JSON.

    The settings UI renders the form controls from ``fields``; secrets are
    masked in ``values`` and reported via ``secrets``.
    """
    engine_id = engine_id.replace("-", "_")
    cls = list_all_engines().get(engine_id)
    if cls is None:
        raise HTTPException(status_code=404, detail="未知引擎")
    engine = cls()
    return _engine_config_response(engine_id, engine)


@router.put("/{engine_id}/config")
async def set_engine_config(engine_id: str, req: EngineConfigSaveRequest):
    """Persist engine config driven by the engine's config schema."""
    engine_id = engine_id.replace("-", "_")
    cls = list_all_engines().get(engine_id)
    if cls is None:
        return {"engine_id": engine_id, "saved": False, "message": "未知引擎"}
    engine = cls()
    try:
        await engine.save_config_values(
            dict(req.values),
            clear=dict(req.clear),
            confirmed=dict(req.confirmed),
        )
    except ValueError as exc:
        return {"engine_id": engine_id, "saved": False, "message": str(exc)}
    except Exception as exc:
        return {
            "engine_id": engine_id,
            "saved": False,
            "message": str(exc) or "保存失败",
        }
    config_store.set_engine_verified(engine_id, False)
    refresh_registry()
    response = _engine_config_response(engine_id, engine)
    response.update({"saved": True, "message": "配置已保存"})
    info = next(
        (item for item in get_available_engines() if item["id"] == engine_id),
        None,
    )
    if info is not None:
        response["engine"] = info
    return response


@router.post("/{engine_id}/config/reveal")
async def reveal_engine_config(engine_id: str, req: EngineConfigRevealRequest):
    """Return a stored secret after an explicit reveal action."""
    engine_id = engine_id.replace("-", "_")
    cls = list_all_engines().get(engine_id)
    if cls is None:
        raise HTTPException(status_code=404, detail="未知引擎")
    engine = cls()
    value = engine.reveal_config_value(req.key)
    return JSONResponse(
        {"key": req.key, "value": value},
        headers={"Cache-Control": "no-store"},
    )


def _engine_config_response(engine_id: str, engine: BaseLLMEngine) -> dict:
    return {
        "engine_id": engine_id,
        "fields": [asdict(field) for field in engine.config_schema()],
        "values": engine.get_config_values(),
        "secrets": engine.get_config_secrets(),
        "configured": engine.is_configured(),
        "installed": engine.is_installed(),
    }
