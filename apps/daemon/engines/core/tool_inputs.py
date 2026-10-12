"""Normalize engine-specific tool inputs into ACP-friendly arguments."""

from collections.abc import Mapping
import json
import re
from typing import Any


_FILE_PATH_KEYS = ("path", "file_path", "filePath", "filename")


def edited_file_paths(events: list[dict[str, Any]]) -> list[str]:
    """Keep only file identities from successful edits in message summaries."""
    calls: dict[str, dict[str, Any]] = {}
    for event in events:
        if event.get("type") not in {"tool_call", "tool_call_update"}:
            continue
        data = event.get("data") or {}
        call_id = str(data.get("tool_call_id") or data.get("id") or "")
        if not call_id:
            continue
        call = calls.setdefault(call_id, {})
        previous = call.get("raw_input")
        call.update(data)
        current = data.get("raw_input")
        if event.get("type") == "tool_call_update" and current is not None:
            if isinstance(previous, str) and isinstance(current, str):
                call["raw_input"] = previous + current
            elif isinstance(previous, dict) and isinstance(current, dict):
                call["raw_input"] = {**previous, **current}

    paths: dict[str, None] = {}
    for call in calls.values():
        if call.get("status") != "completed":
            continue
        kind = call.get("kind")
        name = str(call.get("title") or call.get("name") or "").lower()
        if kind != "edit" and (kind in {"read", "search", "execute"}
            or not re.search(r"edit|write|patch|replace|create|filechange|file_change", name)):
            continue
        args = call.get("raw_input")
        patch = args if isinstance(args, str) else ""
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (ValueError, TypeError):
                args = None
        candidates = []
        if isinstance(args, dict):
            candidates = list(args["changes"]) if isinstance(args.get("changes"), list) else [args]
            patch = args.get("patch") or args.get("input") or ""
        content = call.get("content")
        if isinstance(content, list):
            candidates += [item for item in content if isinstance(item, dict) and item.get("type") == "diff"]
        locations = call.get("locations")
        if isinstance(locations, list):
            candidates += locations
        if not candidates and isinstance(call.get("raw_output"), list):
            candidates = call["raw_output"]
        for candidate in candidates:
            path = candidate if isinstance(candidate, str) else next((
                candidate[key] for key in _FILE_PATH_KEYS
                if isinstance(candidate, dict) and isinstance(candidate.get(key), str) and candidate[key]
            ), None)
            if isinstance(path, str) and path:
                paths[path.replace("\\", "/").removeprefix("./")] = None
        if isinstance(patch, str):
            for path in re.findall(r"^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$", patch, re.M):
                paths[path.replace("\\", "/").removeprefix("./")] = None
    return list(paths)


def file_change_input(changes: Any) -> dict[str, Any]:
    """Expose the first changed file as ACP's conventional ``path`` argument.

    Codex transports a file edit as a ``changes`` list.  Keeping that list
    preserves the native payload, while promoting its first path lets generic
    ACP consumers render the edit like every other file-edit tool.
    """
    normalized = changes if isinstance(changes, list) else []
    result: dict[str, Any] = {"changes": normalized}
    for change in normalized:
        if isinstance(change, str) and change:
            result["path"] = change
            break
        if isinstance(change, Mapping):
            for key in _FILE_PATH_KEYS:
                value = change.get(key)
                if isinstance(value, str) and value:
                    result["path"] = value
                    break
            if "path" in result:
                break
    return result
