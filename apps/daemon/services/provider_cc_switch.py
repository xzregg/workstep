"""Read and normalize cc-switch provider configurations."""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from pathlib import Path
from typing import Any

from services.engine_config_rules import CLAUDE_MODEL_MAP_ALIASES
from services.provider_catalog import (
    detect_provider_type,
    normalize_provider_protocol,
    validate_provider_values,
)

logger = logging.getLogger(__name__)

CC_SWITCH_DEFAULT_BASE_URLS = {
    "codex": "https://api.openai.com/v1",
    "claude": "https://api.anthropic.com/v1",
    "claude-desktop": "https://api.anthropic.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
}


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


def scan_cc_switch_candidates(db_path: Path) -> list[dict[str, Any]]:
    """Discover every provider application type configured in cc-switch."""
    if not db_path.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        conn = sqlite3.connect(
            f"file:{db_path}?mode=ro",
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
cc_switch_candidate = _cc_switch_candidate
