"""LLM engine discovery and connectivity API."""

import asyncio
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from engines.registry import create_engine, get_available_engines, refresh_registry
from services.config import config_store

router = APIRouter(prefix="/api/engine")


class EngineTestRequest(BaseModel):
    engine_id: str = Field(min_length=1)
    timeout_seconds: float = Field(default=30, ge=3, le=120)


class DefaultModelRequest(BaseModel):
    model: str = Field(default="", max_length=200)


class BinaryPathRequest(BaseModel):
    path: str = Field(default="", max_length=4096)


@router.get("/list")
async def list_engines():
    """Return every supported backend and its local availability."""
    return {"engines": get_available_engines()}


@router.post("/refresh")
async def refresh_engines():
    """Re-scan the host for supported execution engines."""
    refresh_registry()
    return {"engines": get_available_engines()}


@router.post("/test")
async def test_engine(req: EngineTestRequest):
    """Delegate the connectivity test to the selected engine adapter."""
    refresh_registry()
    engine = create_engine(req.engine_id)
    if engine is None:
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
    return {"engine_id": req.engine_id, **asdict(result)}


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
    return {
        "engine_id": engine_id,
        "default_model": model,
        "saved": True,
    }


@router.put("/{engine_id}/binary-path")
async def set_binary_path(engine_id: str, req: BinaryPathRequest):
    """Persist or clear a backend's executable path override."""
    supported = {engine["id"] for engine in get_available_engines()}
    if engine_id not in supported or engine_id == "api":
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
    refresh_registry()
    engine_info = next(
        engine for engine in get_available_engines() if engine["id"] == engine_id
    )
    return {
        "engine_id": engine_id,
        "saved": True,
        "engine": engine_info,
    }
