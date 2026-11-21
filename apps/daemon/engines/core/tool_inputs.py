"""Normalize engine-specific tool inputs into ACP-friendly arguments."""

from collections.abc import Mapping
import json
import re
from typing import Any


_FILE_PATH_KEYS = ("path", "file_path", "filePath", "filename")


def _candidate_path(candidate: Any) -> str | None:
    if isinstance(candidate, str):
        return candidate
    if isinstance(candidate, dict):
        return next((
            candidate[key] for key in _FILE_PATH_KEYS
            if isinstance(candidate.get(key), str) and candidate[key]
        ), None)
    return None


class EditedFilePaths:
    """Accumulate file identities without keeping tool output bodies."""

    def __init__(self) -> None:
        self._calls: dict[str, dict[str, Any]] = {}

    def observe(self, event_type: str, data: dict[str, Any]) -> None:
        call_id = str(data.get("tool_call_id") or data.get("id") or "")
        if not call_id:
            return
        call = self._calls.setdefault(call_id, {})
        previous = call.get("raw_input")
        for key in ("status", "kind", "title", "name", "raw_input"):
            if key in data:
                call[key] = data[key]
        for key in ("content", "locations", "raw_output"):
            if key not in data:
                continue
            value = data[key]
            if not isinstance(value, list):
                call.pop(key, None)
                continue
            if key == "content":
                value = (item for item in value if isinstance(item, dict) and item.get("type") == "diff")
            # Keep empty candidates so their presence still suppresses the raw-output fallback.
            call[key] = [_candidate_path(item) for item in value]

        current = data.get("raw_input")
        if event_type == "tool_call_update" and current is not None:
            if isinstance(previous, str) and isinstance(current, str):
                call["raw_input"] = previous + current
            elif isinstance(previous, dict) and isinstance(current, dict):
                call["raw_input"] = {**previous, **current}

    def paths(self) -> list[str]:
        paths: dict[str, None] = {}
        for call in self._calls.values():
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
                changes = args.get("changes")
                candidates = [_candidate_path(item) for item in changes] if isinstance(changes, list) else [_candidate_path(args)]
                patch = args.get("patch") or args.get("input") or ""
            candidates += call.get("content", [])
            candidates += call.get("locations", [])
            if not candidates:
                candidates = call.get("raw_output", [])
            for path in candidates:
                if path:
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
