"""Rebuildable JSONL sidecar: file counts and byte ranges, never patch bodies."""

import difflib
import json
import os
import posixpath
import re
import tempfile
from pathlib import Path

VERSION = 1
PATH_KEYS = ("path", "file_path", "filePath", "filename")


def _record(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def _path(value):
    return posixpath.normpath(value.replace("\\", "/"))


def _key(value, project_root):
    value = _path(value)
    root = _path(str(project_root)).rstrip("/") if project_root else None
    if root and re.match(r"^[a-zA-Z]:/", root):
        value, root = value.casefold(), root.casefold()
    return value[len(root) + 1:] if root and value.startswith(root + "/") else value


def _merge_call(call, data):
    previous = call.get("raw_input")
    call.update(data)
    current = data.get("raw_input")
    if isinstance(previous, str) and isinstance(current, str):
        call["raw_input"] = previous + current
    elif isinstance(previous, dict) and isinstance(current, dict):
        call["raw_input"] = {**previous, **current}


def _candidate(value):
    if isinstance(value, str):
        return {"path": _path(value), "added": None, "removed": None, "patch": None}
    if not isinstance(value, dict):
        return None
    path = next((value[key] for key in PATH_KEYS if isinstance(value.get(key), str) and value[key]), None)
    if not path:
        return None
    result = {"path": _path(path), "added": None, "removed": None, "patch": None}
    patch = value.get("diff") or value.get("patch")
    if isinstance(patch, str) and re.search(r"^@@ -\d+", patch, re.M):
        added = removed = 0
        in_hunk = False
        for line in patch.splitlines():
            if line.startswith("@@ "):
                in_hunk = True
            elif line.startswith("diff "):
                in_hunk = False
            elif in_hunk:
                added += line.startswith("+")
                removed += line.startswith("-")
        return {**result, "added": added, "removed": removed, "patch": patch}
    before = next((value[key] for key in ("oldText", "old_text", "old_string") if key in value), False)
    after = next((value[key] for key in ("newText", "new_text", "new_string") if key in value), None)
    if (isinstance(before, str) or before is None) and isinstance(after, str) and not value.get("replace_all"):
        before = before or ""
        # These fields may contain just the replaced fragment, rather than the
        # full file. Preserve that recorded edit; never read today's workspace.
        patch = "".join(difflib.unified_diff([line + "\n" for line in before.splitlines()],
                                              [line + "\n" for line in after.splitlines()],
                                              fromfile=path, tofile=path))
        result.update(added=len(after.splitlines()), removed=len(before.splitlines()), patch=patch or None)
    return result


def _changes(call):
    kind = call.get("kind")
    name = str(call.get("title") or call.get("name") or "").lower()
    if kind != "edit" and (kind in {"read", "search", "execute"} or not re.search(
        r"edit|write|patch|replace|create|filechange|file_change", name,
    )):
        return []
    raw = call.get("raw_input")
    args = _record(raw)
    content = call.get("content")
    diffs = [item for item in content if isinstance(item, dict) and item.get("type") == "diff"] if isinstance(content, list) else []
    candidates = diffs or (args["changes"] if isinstance(args.get("changes"), list) else [args])
    changes = [change for item in candidates if (change := _candidate(item))]
    if not changes:
        candidates = call.get("locations") or (call.get("raw_output") if isinstance(call.get("raw_output"), list) else [])
        changes = [change for item in candidates if (change := _candidate(item))]
    if changes:
        return changes
    patch = raw if isinstance(raw, str) and "*** Begin Patch" in raw else args.get("patch") or args.get("input")
    if not isinstance(patch, str):
        return []
    current = None
    for line in patch.splitlines():
        header = re.match(r"^\*\*\* (Update|Add|Delete) File: (.+)$", line)
        if header:
            current = {"path": _path(header[2]), "added": None if header[1] == "Delete" else 0,
                       "removed": None if header[1] == "Delete" else 0, "patch": None}
            changes.append(current)
        elif current and line.startswith("*** Move to: "):
            current["path"] = _path(line[len("*** Move to: "):])
        elif line == "*** End Patch":
            current = None
        elif current and current["added"] is not None:
            current["added"] += line.startswith("+")
            current["removed"] += line.startswith("-")
    return changes


def _tool_event(event):
    """Accept native ACP records, legacy histories and AG-UI tool records."""
    kind = event.get("type")
    data = event.get("data") or {}
    if kind in {"tool_call", "tool_call_update"}:
        return str(data.get("tool_call_id") or data.get("id") or ""), data
    if kind == "tool_use":
        return str(data.get("id") or ""), {"name": data.get("name"), "raw_input": data.get("input")}
    if kind == "tool_result":
        return str(data.get("tool_use_id") or ""), {"status": "failed" if data.get("is_error") else "completed",
                                                   "content": data.get("content") if isinstance(data.get("content"), list) else []}
    call_id = str(event.get("toolCallId") or "")
    if kind == "TOOL_CALL_START":
        return call_id, {"name": event.get("toolCallName"), "kind": event.get("kind")}
    if kind == "TOOL_CALL_ARGS":
        return call_id, {"raw_input": event.get("args")}
    if kind == "TOOL_CALL_RESULT":
        return call_id, {"status": "failed" if event.get("isError") else "completed", "content": event.get("content") or []}
    return "", {}


class IndexBuilder:
    def __init__(self):
        self.pending = {}
        self.files = {}

    def observe(self, event, offset, length):
        call_id, data = _tool_event(event)
        if not call_id:
            return
        call, ranges = self.pending.setdefault(call_id, ({}, []))
        ranges.append([offset, length])
        _merge_call(call, data)
        if call.get("status") not in {"completed", "failed", "cancelled"}:
            return
        if call["status"] == "completed":
            for change in _changes(call):
                path = change["path"]
                entry = self.files.setdefault(path, {"path": path, "added": 0, "removed": 0, "has_patch": True, "ranges": []})
                for key in ("added", "removed"):
                    entry[key] = entry[key] + change[key] if entry[key] is not None and change[key] is not None else None
                entry["has_patch"] = entry["has_patch"] and bool(change["patch"])
                entry["ranges"].extend(ranges)
        self.pending.pop(call_id, None)


def _signature(path):
    stat = path.stat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns]


def save_index(path, builder):
    payload = {"version": VERSION, "source": _signature(path), "files": list(builder.files.values())}
    target = path.with_suffix(".changes.json")
    fd, temporary = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return payload


def build_index(path):
    builder = IndexBuilder()
    with path.open("rb") as handle:
        while line := handle.readline():
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(event, dict):
                builder.observe(event, handle.tell() - len(line), len(line))
    return builder


def read_changes(path, *, file_path=None, project_root=None):
    try:
        target = path.with_suffix(".changes.json")
        if target.is_symlink():
            raise ValueError("Invalid index")
        index = json.loads(target.read_text(encoding="utf-8"))
        if index.get("version") != VERSION or index.get("source") != _signature(path):
            raise ValueError("Stale index")
        if not isinstance(index.get("files"), list):
            raise ValueError("Invalid index")
        for item in index["files"]:
            if (not isinstance(item, dict) or not isinstance(item.get("path"), str)
                    or not {"added", "removed", "has_patch", "ranges"}.issubset(item)
                    or type(item.get("has_patch")) is not bool
                    or any(item.get(key) is not None and (type(item[key]) is not int or item[key] < 0)
                           for key in ("added", "removed"))
                    or not isinstance(item.get("ranges"), list)
                    or any(not isinstance(pair, list) or len(pair) != 2
                           or any(type(value) is not int for value in pair)
                           or pair[0] < 0 or pair[1] <= 0 or sum(pair) > index["source"][2]
                           for pair in item["ranges"])):
                raise ValueError("Invalid index entry")
    except (OSError, ValueError, TypeError, AttributeError):
        index = save_index(path, build_index(path))
    return _response(index["files"], path=path, file_path=file_path, project_root=project_root)


def _response(entries, *, path=None, file_path=None, project_root=None):
    def key(value):
        return _key(value, project_root)

    files = {}
    selected = []
    for entry in entries:
        identity = key(entry["path"])
        previous = files.get(identity)
        item = {name: entry[name] for name in ("path", "added", "removed", "has_patch")}
        if previous:
            for name in ("added", "removed"):
                previous[name] = previous[name] + item[name] if previous[name] is not None and item[name] is not None else None
            previous["has_patch"] = previous["has_patch"] and item["has_patch"]
        else:
            files[identity] = item
        if file_path is not None and key(file_path) == identity:
            selected.append(entry)
    result = {"files": list(files.values()), "events": [], "complete": True, "next_cursor": None}
    if file_path is None:
        return result
    if not selected:
        raise ValueError("Changed file not found")
    if not all(entry["has_patch"] for entry in selected):
        return {**result, "patch": None}
    ranges = sorted({tuple(pair) for entry in selected for pair in entry["ranges"]})
    # Validate every offset before seeking; indexes are caches, not authority.
    size = path.stat().st_size
    # Re-read only the selected edit records to reconstruct patch bodies.
    calls = {}
    patches = []
    with path.open("rb") as handle:
        for offset, length in ranges:
            if offset < 0 or length <= 0 or offset + length > size:
                raise ValueError("Invalid file change index range")
            handle.seek(offset)
            event = json.loads(handle.read(length))
            call_id, data = _tool_event(event)
            call = calls.setdefault(call_id, {})
            _merge_call(call, data)
            if call.get("status") == "completed":
                patches.extend(change["patch"] for change in _changes(call)
                               if key(change["path"]) == key(file_path) and change["patch"])
                calls.pop(call_id, None)
    return {**result, "patch": "\n".join(patches) or None}


def legacy_changes(events, *, file_path=None, project_root=None):
    """Old SQLite histories stay readable without copying their bodies into an index."""
    builder = IndexBuilder()
    calls = {}
    patches = []
    for event in events:
        builder.observe(event, 0, 0)
        call_id, data = _tool_event(event)
        if not call_id:
            continue
        call = calls.setdefault(call_id, {})
        _merge_call(call, data)
        if call.get("status") == "completed":
            patches.extend(change for change in _changes(call) if change["patch"])
            calls.pop(call_id, None)
    result = _response(list(builder.files.values()), project_root=project_root)
    if file_path is not None:
        matches = [change for change in patches if _key(change["path"], project_root) == _key(file_path, project_root)]
        selected = next((item for item in result["files"] if _key(item["path"], project_root) == _key(file_path, project_root)), None)
        if selected is None:
            raise ValueError("Changed file not found")
        result["patch"] = ("\n".join(item["patch"] for item in matches) or None) if selected["has_patch"] else None
    return result
