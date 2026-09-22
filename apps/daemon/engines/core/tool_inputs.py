"""Normalize engine-specific tool inputs into ACP-friendly arguments."""

from collections.abc import Mapping
from typing import Any


_FILE_PATH_KEYS = ("path", "file_path", "filePath", "filename")


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
