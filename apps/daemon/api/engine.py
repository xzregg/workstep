"""LLM engine discovery and connectivity API."""

import asyncio
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from api.project_scope import require_catalog_project
from services.project_scope import workspace_engine_catalog

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from engines.core.base import BaseLLMEngine, EngineModel
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
from services import providers as provider_service
from services import engine_runtime
from services.engine_actions import probe_engine
from services.gateway_client.policy import require_managed_capability
from services.project import project_manager

router = APIRouter(prefix="/api/engine")


def _require_managed_engine_permission() -> None:
    try:
        require_managed_capability("engine.install")
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


class EngineTestRequest(BaseModel):
    engine_id: str = Field(min_length=1)
    timeout_seconds: float = Field(default=300, ge=3, le=300)
    values: dict = Field(default_factory=dict)
    clear: dict[str, bool] = Field(default_factory=dict)
    model: str = Field(default="", max_length=200)


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


class EngineRuntimeRequest(BaseModel):
    version: str | None = Field(default=None, max_length=100, pattern=r"^[0-9][0-9A-Za-z.+-]*$")
    rollback: bool = False
    accept_third_party_terms: bool = False


class EngineInstallRequest(BaseModel):
    accept_third_party_terms: bool = False


def _engine_config_snapshot(engine: BaseLLMEngine) -> dict:
    values = dict(engine.get_full_config_values())
    secrets = engine.get_config_secrets()
    for field in engine.full_config_schema():
        if not (field.sensitive or field.type == "password"):
            continue
        values[field.key] = (
            engine.reveal_config_value(field.key)
            if secrets.get(field.key)
            else None
        )
    return values


def _engine_summaries() -> list[dict]:
    return [
        {
            **engine,
            "default_model": config_store.get_engine_default_model(engine["id"]),
        }
        for engine in get_available_engines()
    ]


def _refresh_and_summaries(*, invalidate_scan: bool = True) -> list[dict]:
    if invalidate_scan:
        refresh_registry()
    else:
        refresh_registry(invalidate_scan=False)
    return _engine_summaries()


def _engine_info(engine_id: str) -> dict | None:
    return next(
        (item for item in get_available_engines() if item["id"] == engine_id),
        None,
    )


@router.get("/list")
async def list_engines(project_id: str = ""):
    """Return every supported backend and its local availability."""
    scoped = require_catalog_project(project_id)
    engines = await asyncio.to_thread(_engine_summaries)
    return {"engines": workspace_engine_catalog(engines) if scoped else engines}


class EngineVisibilityRequest(BaseModel):
    enabled: bool


@router.put("/{engine_id}/visibility")
async def set_engine_visibility(engine_id: str, request: EngineVisibilityRequest):
    _require_managed_engine_permission()

    def update():
        if engine_id not in list_all_engines():
            raise HTTPException(status_code=404, detail="引擎不存在")
        config_store.set_engine_enabled(engine_id, request.enabled)
        return {"engines": _refresh_and_summaries()}

    return await asyncio.to_thread(update)


@router.post("/refresh")
async def refresh_engines():
    """Re-scan the host for supported execution engines."""
    _require_managed_engine_permission()
    engines = await asyncio.to_thread(_refresh_and_summaries)
    return {"engines": engines}


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
async def get_execution_default_config(project_id: str = ""):
    require_catalog_project(project_id)
    configured = await asyncio.to_thread(config_store.get_execution_default_engine)
    return {
        "engine": configured,
        "resolved_engine": configured or DEFAULT_EXECUTION_ENGINE,
    }


@router.put("/execution/config")
async def set_execution_default_config(req: DefaultEngineRequest):
    engine_id = req.engine.strip()
    if engine_id:
        await asyncio.to_thread(_validate_engine, engine_id)
    await asyncio.to_thread(config_store.set_execution_default_engine, engine_id)
    return {
        "saved": True,
        "engine": engine_id,
        "resolved_engine": engine_id or DEFAULT_EXECUTION_ENGINE,
    }


@router.get("/coordinator/config")
async def get_coordinator_default_config(project_id: str = ""):
    scoped = require_catalog_project(project_id)
    def load() -> dict:
        return {
            "engine": config_store.get_coordinator_default_engine(),
            "model": config_store.get_coordinator_default_model(),
            "fast_model": config_store.get_coordinator_default_fast_model(),
            "vision_model": config_store.get_coordinator_default_vision_model(),
            "thinking_effort": config_store.get_coordinator_default_thinking_effort(),
            "available_engines": (workspace_engine_catalog(_coordinator_engine_options())
                                  if scoped else _coordinator_engine_options()),
        }

    return await asyncio.to_thread(load)


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
        await asyncio.to_thread(_validate_engine, engine_id, coordinator=True)
    elif model or fast_model or vision_model:
        raise HTTPException(status_code=400, detail="默认模型需要先选择协调引擎")
    await asyncio.to_thread(
        config_store.set_coordinator_defaults,
        engine_id,
        model,
        fast_model,
        vision_model,
        thinking_effort,
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
    _require_managed_engine_permission()
    result = await probe_engine(
        req.engine_id, timeout_seconds=req.timeout_seconds, model=req.model,
        values=req.values, clear=req.clear, store=config_store,
    )
    if result.pop("_unavailable", False):
        return result
    engine_info = await asyncio.to_thread(_engine_info, req.engine_id)
    return {
        **result,
        "engine": engine_info,
    }


@router.get("/{engine_id}/runtime")
async def engine_runtime_catalog(engine_id: str):
    try:
        return await engine_runtime.runtime_manager.catalog(engine_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{engine_id}/runtime/operation")
async def engine_runtime_operation(engine_id: str):
    try:
        return await engine_runtime.runtime_manager.operation(engine_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{engine_id}/runtime/operation", status_code=202)
async def start_engine_runtime_operation(engine_id: str, req: EngineRuntimeRequest):
    _require_managed_engine_permission()
    try:
        return await engine_runtime.runtime_manager.start(
            engine_id, req.version, rollback=req.rollback,
            accept_terms=req.accept_third_party_terms,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{engine_id}/install")
async def install_engine(engine_id: str, req: EngineInstallRequest | None = None):
    _require_managed_engine_permission()
    try:
        async with engine_runtime.runtime_manager.legacy_operation():
            return await _install_engine(engine_id, req)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


async def _install_engine(engine_id: str, req: EngineInstallRequest | None):
    """Compatibility endpoint for clients predating version selection."""
    cls = list_all_engines().get(engine_id)
    if cls is None:
        raise HTTPException(status_code=404, detail="未知引擎")
    engine = cls()
    if (
        engine.requires_third_party_terms_acceptance()
        and not (req and req.accept_third_party_terms)
    ):
        raise HTTPException(
            status_code=400,
            detail="安装此前请先阅读并明确接受第三方服务条款",
        )
    if await asyncio.to_thread(engine.is_installed):
        return {
            "engine_id": engine_id,
            "success": True,
            "already_installed": True,
            "message": "引擎已安装",
            "engine": await asyncio.to_thread(_engine_info, engine_id),
        }
    if engine.install_command() is None:
        raise HTTPException(
            status_code=400,
            detail="该引擎不支持自动安装，请手动安装后重新扫描",
        )
    result = await engine.install()
    engine_info = None
    if result.success:
        engine_info = await asyncio.to_thread(
            lambda: (_refresh_and_summaries(), _engine_info(engine_id))[1]
        )
    return {
        "engine_id": engine_id,
        "success": result.success,
        "already_installed": result.already_installed,
        "message": result.message,
        "engine": engine_info,
    }


@router.post("/{engine_id}/update")
async def update_engine(engine_id: str):
    _require_managed_engine_permission()
    try:
        async with engine_runtime.runtime_manager.legacy_operation():
            return await _update_engine(engine_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


async def _update_engine(engine_id: str):
    """Compatibility endpoint for clients predating version selection."""
    cls = list_all_engines().get(engine_id)
    if cls is None:
        raise HTTPException(status_code=404, detail="未知引擎")
    engine = cls()
    if not await asyncio.to_thread(engine.is_installed):
        raise HTTPException(status_code=400, detail="引擎尚未安装，请先安装")
    if engine.update_command() is None:
        raise HTTPException(status_code=400, detail="该引擎不支持自动更新")
    result = await engine.update()
    engine_info = None
    if result.success:
        def refresh_after_update() -> dict | None:
            config_store.set_engine_verified(engine_id, False)
            refresh_registry()
            return _engine_info(engine_id)

        engine_info = await asyncio.to_thread(refresh_after_update)
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


@router.get("/{engine_id}/quota")
async def get_engine_quota(engine_id: str, project_id: str = ""):
    """Fetch account quota for engines that expose a native quota API."""
    engine = await asyncio.to_thread(
        lambda: (refresh_registry(invalidate_scan=False), create_engine(engine_id))[1]
    )
    get_quota = getattr(engine, "get_quota", None) if engine is not None else None
    if not callable(get_quota):
        return {"engine_id": engine_id, "supported": False, "quota": None}
    project = (
        project_manager.get_project_by_id(project_id.strip())
        if project_id.strip()
        else None
    )
    quota = await get_quota(
        cwd=str(project.path) if project else str(Path.cwd())
    )
    if quota is None:
        return {"engine_id": engine_id, "supported": False, "quota": None}
    return {
        "engine_id": engine_id,
        "supported": True,
        "quota": quota,
    }


@router.get("/{engine_id}/models")
async def list_engine_models(
    engine_id: str,
    provider_id: str = "",
    refresh: bool = False,
    project_id: str = "",
):
    """Return native models or the selected provider's cached model list."""
    scoped = require_catalog_project(project_id)
    if scoped and refresh:
        raise HTTPException(status_code=403, detail="项目会话不能刷新宿主模型目录")
    engine = await asyncio.to_thread(
        lambda: (refresh_registry(invalidate_scan=False), create_engine(engine_id))[1]
    )
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
        resolve_provider = getattr(engine, "resolve_provider_runtime", None)
        provider_runtime = (
            await asyncio.to_thread(
                resolve_provider, provider_id=provider_id.strip()
            )
            if callable(resolve_provider)
            else None
        )
        effective_provider = provider_runtime.provider_id if provider_runtime else ""
        if effective_provider:
            # Provider catalogs contain the user's saved selection. Refresh
            # only rereads it; model discovery belongs to provider settings.
            models = await asyncio.to_thread(
                provider_service.saved_models,
                effective_provider,
                provider_runtime.protocol,
            )
            fetched_at = (
                await asyncio.to_thread(
                    config_store.get_provider_models,
                    effective_provider,
                    provider_runtime.protocol,
                )
            ).get("fetched_at")
        else:
            entry = await asyncio.to_thread(config_store.get_engine_models, engine_id)
            if refresh:
                models = await asyncio.wait_for(
                    engine.list_models(**models_kwargs),
                    timeout=15,
                )
                fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
                await asyncio.to_thread(
                    config_store.set_engine_models,
                    engine_id,
                    [asdict(model) for model in models],
                    fetched_at,
                )
            elif entry:
                models = [
                    EngineModel(
                        id=str(item["id"]),
                        label=str(item.get("label") or item["id"]),
                        description=(
                            str(item["description"])
                            if item.get("description") is not None
                            else None
                        ),
                    )
                    for item in entry.get("models", [])
                    if isinstance(item, dict) and str(item.get("id") or "").strip()
                ]
                fetched_at = entry.get("fetched_at")
            else:
                models = []
        error = None
    except asyncio.TimeoutError:
        models = []
        error = "读取模型列表超时"
    except Exception as exc:
        models = []
        error = "读取模型列表失败" if scoped else (str(exc) or "读取模型列表失败")
    return {
        "engine_id": engine_id,
        "models": [asdict(model) for model in models],
        "default_model": await asyncio.to_thread(
            config_store.get_engine_default_model, engine_id
        ),
        "fetched_at": fetched_at,
        "error": error,
    }


@router.put("/{engine_id}/default-model")
async def set_default_model(engine_id: str, req: DefaultModelRequest):
    """Persist the model inherited by steps without an explicit model."""
    engine = await asyncio.to_thread(
        lambda: (refresh_registry(), create_engine(engine_id))[1]
    )
    if engine is None:
        return {
            "engine_id": engine_id,
            "default_model": "",
            "saved": False,
            "message": "引擎未安装或当前不可用",
        }
    model = req.model.strip()
    await asyncio.to_thread(config_store.set_engine_default_model, engine_id, model)
    return {
        "engine_id": engine_id,
        "default_model": model,
        "saved": True,
    }


@router.put("/{engine_id}/binary-path")
async def set_binary_path(engine_id: str, req: BinaryPathRequest):
    """Persist or clear a backend's executable path override."""
    supported = await asyncio.to_thread(
        lambda: {engine["id"] for engine in get_available_engines()}
    )
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
        if not await asyncio.to_thread(path.is_file):
            return {
                "engine_id": engine_id,
                "saved": False,
                "message": "指定的可执行文件不存在",
            }
        normalized = str(await asyncio.to_thread(path.resolve))
    else:
        normalized = ""

    def save_binary_path() -> dict | None:
        config_store.set_engine_binary_path(engine_id, normalized)
        config_store.set_engine_verified(engine_id, False)
        config_store.clear_engine_models(engine_id)
        refresh_registry()
        return _engine_info(engine_id)

    engine_info = await asyncio.to_thread(save_binary_path)
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
    return await asyncio.to_thread(_engine_config_response, engine_id, engine)


@router.put("/{engine_id}/config")
async def set_engine_config(engine_id: str, req: EngineConfigSaveRequest):
    """Persist engine config driven by the engine's config schema."""
    engine_id = engine_id.replace("-", "_")
    cls = list_all_engines().get(engine_id)
    if cls is None:
        return {"engine_id": engine_id, "saved": False, "message": "未知引擎"}
    engine = cls()
    previous_config = await asyncio.to_thread(_engine_config_snapshot, engine)
    try:
        await engine.save_full_config_values(
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
    def finish_save() -> tuple[dict, dict | None]:
        current_config = _engine_config_snapshot(engine)
        provider_changed = (
            str(previous_config.get("provider_id") or "").strip()
            != str(current_config.get("provider_id") or "").strip()
        )
        if current_config != previous_config:
            config_store.clear_engine_models(engine_id)
        if provider_changed:
            config_store.set_engine_verified(engine_id, False)
        refresh_registry()
        return _engine_config_response(engine_id, engine), _engine_info(engine_id)

    response, info = await asyncio.to_thread(finish_save)
    response.update({"saved": True, "message": "配置已保存"})
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
    value = await asyncio.to_thread(engine.reveal_config_value, req.key)
    return JSONResponse(
        {"key": req.key, "value": value},
        headers={"Cache-Control": "no-store"},
    )


def _engine_config_response(engine_id: str, engine: BaseLLMEngine) -> dict:
    return {
        "engine_id": engine_id,
        "fields": [asdict(field) for field in engine.full_config_schema()],
        "values": engine.get_full_config_values(),
        "secrets": engine.get_config_secrets(),
        "configured": engine.is_configured(),
        "installed": engine.is_installed(),
    }


# Host-only custom engine operations reuse the existing engine router/auth boundary.
from api.custom_engine import router as custom_engine_router
router.include_router(custom_engine_router)
