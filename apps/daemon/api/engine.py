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
from services.engine_efforts import is_supported_effort
from services.config import (
    DEFAULT_EXECUTION_ENGINE,
    config_store,
)
from services import providers as provider_service
from services import engine_runtime
from services.engine_actions import probe_engine
from services.project import project_manager

router = APIRouter(prefix="/api/engine")

from api.engine_login import router as login_router
router.include_router(login_router)


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
    from services import engine_quota as engine_quota_service
    require_catalog_project("")

    def update():
        if engine_id not in list_all_engines():
            raise HTTPException(status_code=404, detail="Engine does not exist")
        config_store.set_engine_enabled(engine_id, request.enabled)
        return {"engines": _refresh_and_summaries()}

    result = await asyncio.to_thread(update)
    engine_quota_service.unified_quota_service.invalidate()
    return result


@router.post("/refresh")
async def refresh_engines():
    """Re-scan the host for supported execution engines."""
    from services import engine_quota as engine_quota_service
    require_catalog_project("")
    engines = await asyncio.to_thread(_refresh_and_summaries)
    engine_quota_service.unified_quota_service.invalidate()
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
        raise HTTPException(status_code=400, detail="Engine not installed or not configured")
    if coordinator and not engine.capabilities.supports_coordinator:
        raise HTTPException(status_code=400, detail="This engine does not support coordination mode")
    if not config_store.is_engine_verified(engine_id):
        raise HTTPException(status_code=400, detail="Please complete the engine test in Settings first")
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
    require_catalog_project("")
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
    require_catalog_project("")
    engine_id = req.engine.strip()
    model = req.model.strip()
    fast_model = req.fast_model.strip()
    vision_model = req.vision_model.strip()
    thinking_effort = req.thinking_effort.strip()
    if not await asyncio.to_thread(is_supported_effort, thinking_effort, engine_id, model, "task_coordinator"):
        raise HTTPException(status_code=400, detail="Unsupported thinking intensity")
    if engine_id:
        await asyncio.to_thread(_validate_engine, engine_id, coordinator=True)
    elif model or fast_model or vision_model:
        raise HTTPException(status_code=400, detail="The default model requires selecting a coordination engine first")
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
    require_catalog_project("")
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
    require_catalog_project("")
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
    require_catalog_project("")
    try:
        async with engine_runtime.runtime_manager.legacy_operation():
            return await _install_engine(engine_id, req)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


async def _install_engine(engine_id: str, req: EngineInstallRequest | None):
    """Compatibility endpoint for clients predating version selection."""
    cls = list_all_engines().get(engine_id)
    if cls is None:
        raise HTTPException(status_code=404, detail="Unknown engine")
    engine = cls()
    if (
        engine.requires_third_party_terms_acceptance()
        and not (req and req.accept_third_party_terms)
    ):
        raise HTTPException(
            status_code=400,
            detail="Before installation, please read and explicitly accept the third-party service terms",
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
            detail="This engine does not support automatic installation. Please install manually and rescan.",
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
    require_catalog_project("")
    try:
        async with engine_runtime.runtime_manager.legacy_operation():
            return await _update_engine(engine_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


async def _update_engine(engine_id: str):
    """Compatibility endpoint for clients predating version selection."""
    cls = list_all_engines().get(engine_id)
    if cls is None:
        raise HTTPException(status_code=404, detail="Unknown engine")
    engine = cls()
    if not await asyncio.to_thread(engine.is_installed):
        raise HTTPException(status_code=400, detail="Engine not installed, please install first")
    if engine.update_command() is None:
        raise HTTPException(status_code=400, detail="This engine does not support automatic updates")
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
        raise HTTPException(status_code=404, detail="Unknown engine")
    root = project_root.strip() or None
    if not root and project_id.strip():
        project = project_manager.get_project_by_id(project_id.strip())
        root = str(project.path) if project else None
    result = await cls().inspect_capabilities(project_root=root)
    if result is None:
        raise HTTPException(status_code=400, detail="This engine does not support viewing load capacity")
    return result


@router.get("/quota")
async def get_all_engine_quotas(project_id: str = "", refresh: bool = False):
    """Query account quotas for all enabled, installed engines that support quota."""
    from contextlib import suppress
    from engines.core.process_cleanup import finish_cleanup
    from engines.core.quota import query_quota
    from services import engine_quota as engine_quota_service

    require_catalog_project(project_id)
    normalized_project = project_id.strip()
    scope_key = engine_quota_service.quota_scope_key(normalized_project)
    service = engine_quota_service.unified_quota_service

    async def collect() -> list[dict]:
        def resolve_targets():
            refresh_registry(invalidate_scan=False)
            project = (
                project_manager.get_project_by_id(normalized_project)
                if normalized_project else None
            )
            cwd = str(project.path) if project else str(Path.cwd())
            targets: list[tuple[str, str | None, BaseLLMEngine]] = []
            for item in get_available_engines():
                if not item.get("enabled", True):
                    continue
                if item.get("disabled"):
                    continue
                if not item.get("installed"):
                    continue
                if not item.get("supports_quota"):
                    continue
                engine = create_engine(item["id"])
                if engine is None or not engine.supports_quota:
                    continue
                name = str(item.get("name") or "").strip() or None
                targets.append((item["id"], name, engine))
            return cwd, targets

        preparing = asyncio.create_task(asyncio.to_thread(resolve_targets))
        try:
            cwd, targets = await asyncio.shield(preparing)
        except asyncio.CancelledError:
            with suppress(Exception):
                await finish_cleanup(preparing)
            raise

        if not targets:
            return []

        semaphore = service.collector_semaphore()

        async def collect_one(engine_id: str, name: str | None, engine: BaseLLMEngine) -> dict:
            try:
                async with asyncio.timeout(25):
                    async with semaphore:
                        result = await query_quota(engine, cwd)
            except asyncio.CancelledError:
                raise
            except Exception:
                result = {
                    "engine_id": engine_id,
                    "supported": True,
                    "status": "unavailable",
                    "quota": None,
                }
            if name and "name" not in result:
                result["name"] = name
            return result

        return list(await asyncio.gather(*(
            collect_one(engine_id, name, engine)
            for engine_id, name, engine in targets
        )))

    try:
        return await service.get(scope_key, collect, refresh=refresh)
    except (engine_quota_service.QuotaBusyError, TimeoutError):
        raise HTTPException(status_code=503, detail="Engine quota temporarily unavailable")


@router.get("/{engine_id}/quota")
async def get_engine_quota(engine_id: str, project_id: str = ""):
    """Read the engine-owned account quota through the shared contract."""
    from engines.core.quota import query_quota
    from services.engine_quota import quota_requests, QuotaBusyError

    require_catalog_project(project_id)
    project = (
        project_manager.get_project_by_id(project_id.strip())
        if project_id.strip() else None
    )
    async def collect():
        preparing = asyncio.create_task(asyncio.to_thread(
            lambda: (refresh_registry(invalidate_scan=False), create_engine(engine_id))[1]
        ))
        try:
            engine = await asyncio.shield(preparing)
        except asyncio.CancelledError:
            from contextlib import suppress
            from engines.core.process_cleanup import finish_cleanup
            # Keep the quota slot until the synchronous disk scan has finished;
            # cancelled refreshes must not accumulate default-executor workers.
            with suppress(Exception):
                await finish_cleanup(preparing)
            raise
        if engine is None:
            raise HTTPException(status_code=404, detail="Unknown engine")
        cwd = str(project.path) if project else await asyncio.to_thread(lambda: str(Path.cwd()))
        return await query_quota(engine, cwd)

    try:
        # Authorization precedes joining a shared query; project scopes stay separate.
        return await quota_requests.run((engine_id, project_id.strip()), collect)
    except (QuotaBusyError, TimeoutError):
        raise HTTPException(status_code=503, detail="Engine quota temporarily unavailable")


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
        raise HTTPException(status_code=403, detail="Project session cannot refresh the host model directory")
    engine = await asyncio.to_thread(
        lambda: (refresh_registry(invalidate_scan=False), create_engine(engine_id))[1]
    )
    if engine is None:
        return {
            "engine_id": engine_id,
            "models": [],
            "default_model": "",
            "error": "Engine not installed or currently unavailable",
        }
    fetched_at = None
    try:
        project = project_manager.get_project_by_id(project_id.strip()) if project_id.strip() else None
        models_kwargs: dict = {"cwd": str(project.path) if project else str(Path.cwd())}
        resolve_provider = getattr(engine, "resolve_provider_catalog", None)
        provider_catalog = (
            await asyncio.to_thread(
                resolve_provider, provider_id=provider_id.strip()
            )
            if callable(resolve_provider)
            else None
        )
        if provider_catalog:
            effective_provider, protocol = provider_catalog
            # Provider catalogs contain the user's saved selection. Refresh
            # only rereads it; model discovery belongs to provider settings.
            models = await asyncio.to_thread(
                provider_service.saved_models,
                effective_provider,
                protocol,
            )
            fetched_at = (
                await asyncio.to_thread(
                    config_store.get_provider_models,
                    effective_provider,
                    protocol,
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
                    [model.to_dict() for model in models],
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
                        supported_reasoning_efforts=item.get("supported_reasoning_efforts"),
                        is_default=bool(item.get("is_default", False)),
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
        error = "Model list request timed out"
    except Exception as exc:
        models = []
        error = "Failed to load the model list" if scoped else (str(exc) or "Failed to load the model list")
    return {
        "engine_id": engine_id,
        "models": [model.to_dict() for model in models],
        "default_model": await asyncio.to_thread(
            config_store.get_engine_default_model, engine_id
        ),
        "fetched_at": fetched_at,
        "error": error,
    }


@router.put("/{engine_id}/default-model")
async def set_default_model(engine_id: str, req: DefaultModelRequest):
    """Persist the model inherited by steps without an explicit model."""
    require_catalog_project("")
    engine = await asyncio.to_thread(
        lambda: (refresh_registry(), create_engine(engine_id))[1]
    )
    if engine is None:
        return {
            "engine_id": engine_id,
            "default_model": "",
            "saved": False,
            "message": "Engine not installed or currently unavailable",
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
    require_catalog_project("")
    supported = await asyncio.to_thread(
        lambda: {engine["id"] for engine in get_available_engines()}
    )
    if engine_id not in supported or engine_id == "pydantic_ai":
        return {
            "engine_id": engine_id,
            "saved": False,
            "message": "This engine does not support executable path configuration",
        }

    raw_path = req.path.strip()
    if raw_path:
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            return {
                "engine_id": engine_id,
                "saved": False,
                "message": "Please enter the absolute path of the executable file",
            }
        if not await asyncio.to_thread(path.is_file):
            return {
                "engine_id": engine_id,
                "saved": False,
                "message": "The specified executable does not exist",
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
    from services import engine_quota as engine_quota_service
    engine_quota_service.unified_quota_service.invalidate()
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
        raise HTTPException(status_code=404, detail="Unknown engine")
    engine = cls()
    return await asyncio.to_thread(_engine_config_response, engine_id, engine)


@router.put("/{engine_id}/config")
async def set_engine_config(engine_id: str, req: EngineConfigSaveRequest):
    """Persist engine config driven by the engine's config schema."""
    require_catalog_project("")
    engine_id = engine_id.replace("-", "_")
    cls = list_all_engines().get(engine_id)
    if cls is None:
        return {"engine_id": engine_id, "saved": False, "message": "Unknown engine"}
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
            "message": str(exc) or "Save failed",
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
    from services import engine_quota as engine_quota_service
    engine_quota_service.unified_quota_service.invalidate()
    response.update({"saved": True, "message": "配置已保存"})
    if info is not None:
        response["engine"] = info
    return response


@router.post("/{engine_id}/config/reveal")
async def reveal_engine_config(engine_id: str, req: EngineConfigRevealRequest):
    """Return a stored secret after an explicit reveal action."""
    require_catalog_project("")
    engine_id = engine_id.replace("-", "_")
    cls = list_all_engines().get(engine_id)
    if cls is None:
        raise HTTPException(status_code=404, detail="Unknown engine")
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
