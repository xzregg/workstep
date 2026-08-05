"""LLM engine discovery and connectivity API."""

import asyncio
from dataclasses import asdict
import ipaddress
from pathlib import Path
import socket
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from engines.registry import create_engine, get_available_engines, refresh_registry
from engines.api import APIEngine
from engines.pydantic_ai import PydanticAIEngine
from services.config import CLAUDE_PERMISSION_MODES, config_store

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


class BinaryPathRequest(BaseModel):
    path: str = Field(default="", max_length=4096)


class ClaudePermissionModeRequest(BaseModel):
    mode: str = Field(min_length=1, max_length=50)
    confirmed_dangerous: bool = False


class ApiEngineConfigRequest(BaseModel):
    provider: str = Field(default="openai", max_length=50)
    base_url: str = Field(default="", max_length=2048)
    api_key: str | None = Field(default=None, max_length=8192)
    clear_api_key: bool = False
    model: str = Field(default="", max_length=200)


class ApiEngineModelsRequest(BaseModel):
    provider: str = Field(default="openai", max_length=50)
    base_url: str = Field(default="", max_length=2048)
    api_key: str | None = Field(default=None, max_length=8192)


def _validate_api_base_url(base_url: str) -> str | None:
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return "API 地址必须是完整的 http:// 或 https:// URL"
    if parsed.scheme == "https":
        return None
    try:
        addresses = {
            ipaddress.ip_address(item[4][0])
            for item in socket.getaddrinfo(parsed.hostname, parsed.port or 80)
        }
    except socket.gaierror:
        return "HTTP 地址仅允许本机回环地址；远程接口请使用 HTTPS"
    if not addresses or any(not address.is_loopback for address in addresses):
        return "HTTP 地址仅允许 localhost/127.0.0.1；远程接口请使用 HTTPS"
    return None


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
            or item.get("id") in {"api", "pydantic_ai"}
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
        "resolved_engine": configured or "claude",
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
        "resolved_engine": engine_id or "claude",
    }


@router.get("/coordinator/config")
async def get_coordinator_default_config():
    return {
        "engine": config_store.get_coordinator_default_engine(),
        "model": config_store.get_coordinator_default_model(),
        "fast_model": config_store.get_coordinator_default_fast_model(),
        "available_engines": _coordinator_engine_options(),
    }


@router.put("/coordinator/config")
async def set_coordinator_default_config(req: CoordinatorDefaultsRequest):
    engine_id = req.engine.strip()
    model = req.model.strip()
    fast_model = req.fast_model.strip()
    if engine_id:
        _validate_engine(engine_id, coordinator=True)
    elif model or fast_model:
        raise HTTPException(status_code=400, detail="默认模型需要先选择协调引擎")
    config_store.set_coordinator_defaults(engine_id, model, fast_model)
    return {
        "saved": True,
        "engine": engine_id,
        "model": model,
        "fast_model": fast_model,
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


@router.get("/{engine_id}/models")
async def list_engine_models(engine_id: str):
    """Return selectable models through the engine adapter interface."""
    refresh_registry()
    engine = create_engine(engine_id)
    if engine is None:
        return {
            "engine_id": engine_id,
            "models": [],
            "default_model": "",
            "error": "引擎未安装或当前不可用",
        }
    try:
        models = await asyncio.wait_for(
            engine.list_models(cwd=str(Path.cwd())),
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
        "engine_id": engine_id,
        "models": [asdict(model) for model in models],
        "default_model": config_store.get_engine_default_model(engine_id),
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
    if engine_id not in supported or engine_id in {"api", "pydantic_ai"}:
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


@router.get("/api/config")
async def get_api_engine_config():
    config = config_store.get_api_engine_config()
    return {
        "provider": config["provider"],
        "base_url": config["base_url"],
        "model": config["model"],
        "has_api_key": bool(config["api_key"]),
        "configured": bool(config["base_url"] and config["model"]),
    }


@router.post("/api/key")
async def reveal_api_engine_key():
    """Return the stored key only after an explicit reveal action."""
    config = config_store.get_api_engine_config()
    return JSONResponse(
        {"api_key": config["api_key"]},
        headers={"Cache-Control": "no-store"},
    )


@router.post("/api/models")
async def list_api_engine_models(req: ApiEngineModelsRequest):
    provider = req.provider.strip().lower()
    if provider not in {"openai", "anthropic"}:
        return {"models": [], "error": "不支持的接口类型"}
    base_url = req.base_url.strip().rstrip("/")
    url_error = _validate_api_base_url(base_url)
    if url_error:
        return {"models": [], "error": url_error}
    stored = config_store.get_api_engine_config()
    api_key = stored["api_key"] if req.api_key is None else req.api_key.strip()
    try:
        models = await asyncio.wait_for(
            APIEngine().list_models_for_config(
                provider=provider,
                base_url=base_url,
                api_key=api_key,
            ),
            timeout=15,
        )
        error = None
    except asyncio.TimeoutError:
        models = []
        error = "读取模型列表超时"
    except Exception as exc:
        models = []
        error = str(exc) or "读取模型列表失败"
    return {"models": [asdict(model) for model in models], "error": error}


@router.put("/api/config")
async def set_api_engine_config(req: ApiEngineConfigRequest):
    provider = req.provider.strip().lower()
    if provider not in {"openai", "anthropic"}:
        return {"saved": False, "message": "不支持的接口类型"}
    base_url = req.base_url.strip().rstrip("/")
    model = req.model.strip()
    if not base_url or not model:
        return {"saved": False, "message": "API 地址和模型不能为空"}
    url_error = _validate_api_base_url(base_url)
    if url_error:
        return {"saved": False, "message": url_error}
    api_key = "" if req.clear_api_key else (
        req.api_key.strip()
        if req.api_key is not None and req.api_key.strip()
        else None
    )
    config_store.set_api_engine_config(
        provider=provider,
        base_url=base_url,
        api_key=api_key,
        model=model,
    )
    config_store.set_engine_verified("api", False)
    refresh_registry()
    engine = next(item for item in get_available_engines() if item["id"] == "api")
    config = config_store.get_api_engine_config()
    return {
        "saved": True,
        "config": {
            "provider": config["provider"],
            "base_url": config["base_url"],
            "model": config["model"],
            "has_api_key": bool(config["api_key"]),
            "configured": engine["configured"],
        },
        "engine": engine,
    }


@router.get("/pydantic-ai/config")
async def get_pydantic_ai_engine_config():
    config = config_store.get_pydantic_ai_engine_config()
    return {
        "provider": config["provider"],
        "base_url": config["base_url"],
        "model": config["model"],
        "has_api_key": bool(config["api_key"]),
        "configured": bool(config["base_url"] and config["model"]),
    }


@router.post("/pydantic-ai/key")
async def reveal_pydantic_ai_engine_key():
    """Return the Pydantic AI provider key after an explicit reveal action."""
    config = config_store.get_pydantic_ai_engine_config()
    return JSONResponse(
        {"api_key": config["api_key"]},
        headers={"Cache-Control": "no-store"},
    )


@router.post("/pydantic-ai/models")
async def list_pydantic_ai_engine_models(req: ApiEngineModelsRequest):
    provider = req.provider.strip().lower()
    if provider not in {"openai", "anthropic"}:
        return {"models": [], "error": "不支持的 Provider 类型"}
    base_url = req.base_url.strip().rstrip("/")
    url_error = _validate_api_base_url(base_url)
    if url_error:
        return {"models": [], "error": url_error}
    stored = config_store.get_pydantic_ai_engine_config()
    api_key = stored["api_key"] if req.api_key is None else req.api_key.strip()
    try:
        models = await asyncio.wait_for(
            PydanticAIEngine().list_models_for_config(
                provider=provider,
                base_url=base_url,
                api_key=api_key,
            ),
            timeout=15,
        )
        error = None
    except asyncio.TimeoutError:
        models = []
        error = "读取模型列表超时"
    except Exception as exc:
        models = []
        error = str(exc) or "读取模型列表失败"
    return {"models": [asdict(model) for model in models], "error": error}


@router.put("/pydantic-ai/config")
async def set_pydantic_ai_engine_config(req: ApiEngineConfigRequest):
    provider = req.provider.strip().lower()
    if provider not in {"openai", "anthropic"}:
        return {"saved": False, "message": "不支持的 Provider 类型"}
    base_url = req.base_url.strip().rstrip("/")
    model = req.model.strip()
    if not base_url or not model:
        return {"saved": False, "message": "Provider 地址和模型不能为空"}
    url_error = _validate_api_base_url(base_url)
    if url_error:
        return {"saved": False, "message": url_error}
    api_key = "" if req.clear_api_key else (
        req.api_key.strip()
        if req.api_key is not None and req.api_key.strip()
        else None
    )
    config_store.set_pydantic_ai_engine_config(
        provider=provider,
        base_url=base_url,
        api_key=api_key,
        model=model,
    )
    config_store.set_engine_verified("pydantic_ai", False)
    refresh_registry()
    engine = next(
        item for item in get_available_engines() if item["id"] == "pydantic_ai"
    )
    config = config_store.get_pydantic_ai_engine_config()
    return {
        "saved": True,
        "config": {
            "provider": config["provider"],
            "base_url": config["base_url"],
            "model": config["model"],
            "has_api_key": bool(config["api_key"]),
            "configured": engine["configured"],
        },
        "engine": engine,
    }


@router.get("/claude/permission-mode")
async def get_claude_permission_mode():
    mode = config_store.get_claude_permission_mode()
    return {
        "mode": mode,
        "confirmed": bool(mode),
        "options": sorted(CLAUDE_PERMISSION_MODES),
    }


@router.put("/claude/permission-mode")
async def set_claude_permission_mode(req: ClaudePermissionModeRequest):
    if req.mode not in CLAUDE_PERMISSION_MODES:
        return {
            "saved": False,
            "mode": config_store.get_claude_permission_mode(),
            "message": "不支持的 Claude Code 权限模式",
        }
    if req.mode == "bypassPermissions" and not req.confirmed_dangerous:
        return {
            "saved": False,
            "mode": config_store.get_claude_permission_mode(),
            "message": "bypassPermissions 需要明确确认风险",
        }
    config_store.set_claude_permission_mode(req.mode)
    return {"saved": True, "mode": req.mode, "confirmed": True}
