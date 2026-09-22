"""Codex-only rendering helpers for its private ``visualize`` content marker."""

from __future__ import annotations

import json
from json import JSONDecoder
from urllib.parse import quote

# Codex emits the marker in two observed shapes:
#   \ue200visualize\ue202{"path": "..."}\ue201   (skill reference contract)
#   \ue200visualize{"path": "..."}\ue201          (emitted without the separator)
# The separator is therefore optional after the opening word.
VISUALIZE_OPEN = "\ue200visualize"
VISUALIZE_SEPARATOR = "\ue202"
VISUALIZE_END = "\ue201"

#: Engine ids whose messages may carry the private ``visualize`` marker.
CODEX_ENGINE_IDS = frozenset({"codex", "codex_sdk"})

# Newer Codex output sometimes emits a bare ``visualize{JSON}`` marker with no
# private-use delimiters. Only a marker that occupies its own line at the very
# end of the text is treated as one, so prose or fenced examples stay untouched.
_BARE_KEYWORD = "visualize"
_REPLACEMENT = chr(0xFFFD)
_JSON_DECODER = json.JSONDecoder()


def _trailing_bare_marker(text: str) -> tuple[int, int] | None:
    """Return ``(start, end)`` for a trailing bare visualize marker."""
    search_end = len(text)
    while True:
        start = text.rfind(_BARE_KEYWORD, 0, search_end)
        if start < 0:
            return None
        search_end = start
        if start > 0 and text[start - 1] != "\n":
            continue
        cursor = start + len(_BARE_KEYWORD)
        if text.startswith(VISUALIZE_SEPARATOR, cursor):
            cursor += len(VISUALIZE_SEPARATOR)
        while cursor < len(text) and text[cursor] in " \t":
            cursor += 1
        if cursor >= len(text) or text[cursor] != "{":
            continue
        try:
            data, consumed = _JSON_DECODER.raw_decode(text[cursor:])
        except ValueError:
            continue
        if not isinstance(data, dict) or not isinstance(data.get("path"), str):
            continue
        marker_end = cursor + consumed
        tail = text[marker_end:].strip("\n\r \t")
        if not tail:
            return start, marker_end
        # Corrupted terminator (U+FFFD bytes) is only swallowed once JSON parsed.
        if all(ch == _REPLACEMENT for ch in tail):
            return start, len(text)
    return None


def _bare_marker_link(text: str, start: int, end: int) -> str:
    payload = text[start:end]
    cursor = len(_BARE_KEYWORD)
    if payload.startswith(VISUALIZE_SEPARATOR, cursor):
        cursor += len(VISUALIZE_SEPARATOR)
    while cursor < len(payload) and payload[cursor] in " \t":
        cursor += 1
    try:
        data, _ = _JSON_DECODER.raw_decode(payload[cursor:])
    except ValueError:
        return ""
    if isinstance(data, dict) and isinstance(data.get("path"), str):
        return _file_link(data["path"])
    return ""


def _partial_open_len(text: str) -> int:
    """Length of a trailing prefix of ``VISUALIZE_OPEN``, if any."""
    for length in range(min(len(text), len(VISUALIZE_OPEN) - 1), 0, -1):
        if text.endswith(VISUALIZE_OPEN[:length]):
            return length
    return 0


def _partial_bare_len(text: str) -> int:
    """Length of a trailing prefix of the bare ``visualize`` keyword, if any."""
    for length in range(min(len(text), len(_BARE_KEYWORD) - 1), 0, -1):
        if text.endswith(_BARE_KEYWORD[:length]):
            return length
    return 0


def _trailing_bare_start(text: str) -> int | None:
    """Start index of a trailing line that begins a bare ``visualize`` marker.

    Used while streaming so an incomplete ``visualize{`` JSON payload is held
    back instead of being emitted as raw text.
    """
    newline = text.rfind("\n")
    line_start = newline + 1
    candidate = text[line_start:].lstrip(" \t")
    if not candidate.startswith(_BARE_KEYWORD):
        return None
    rest = candidate[len(_BARE_KEYWORD):]
    if rest.startswith(VISUALIZE_SEPARATOR):
        rest = rest[len(VISUALIZE_SEPARATOR):]
    rest = rest.lstrip(" \t")
    # Hold the bare keyword alone until the ``{`` arrives; already-emitted text
    # cannot be rewritten when the following chunk turns out to be a marker.
    if rest and not rest.startswith("{"):
        return None
    return line_start


def _payload_start(text: str, open_end: int) -> int:
    if text.startswith(VISUALIZE_SEPARATOR, open_end):
        return open_end + len(VISUALIZE_SEPARATOR)
    return open_end


def _file_link(path: str) -> str:
    name = path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    if not name:
        return ""
    normalized = path.replace("\\", "/")
    if len(normalized) >= 2 and normalized[1] == ":":
        normalized = "/" + normalized
    target = "file://" + quote(normalized, safe="/:")
    return f"[{name}]({target})"


#: 旧数据在落库/回放链路里可能把 U+E201 结束标记损坏成替换符。
VISUALIZE_CORRUPTED_END = "\ufffd\ufffd"


def _marker_payload(text: str, payload_start: int) -> tuple[str, int] | None:
    """Return ``(json_payload, marker_end)`` for the marker starting at payload_start.

    Prefers the real U+E201 terminator. Falls back to a corrupted
    ``\ufffd\ufffd`` tail only when the JSON between them parses cleanly, so
    genuinely truncated streaming text is still preserved verbatim.
    """
    end = text.find(VISUALIZE_END, payload_start)
    if end >= 0:
        return text[payload_start:end], end + len(VISUALIZE_END)
    corrupt = text.find(VISUALIZE_CORRUPTED_END, payload_start)
    if corrupt < 0:
        return None
    payload = text[payload_start:corrupt]
    try:
        json.loads(payload)
    except (TypeError, ValueError):
        return None
    return payload, corrupt + len(VISUALIZE_CORRUPTED_END)


def convert_visualize_markers(text: str) -> str:
    """Replace complete ``visualize`` markers with Markdown file links.

    Malformed JSON or markers without a usable path are left untouched so the
    original engine output is never silently dropped.
    """
    result: list[str] = []
    cursor = 0
    while True:
        start = text.find(VISUALIZE_OPEN, cursor)
        if start < 0:
            result.append(text[cursor:])
            break
        open_end = start + len(VISUALIZE_OPEN)
        payload_start = _payload_start(text, open_end)
        resolved = _marker_payload(text, payload_start)
        if resolved is None:
            result.append(text[cursor:])
            break
        payload, marker_end = resolved
        result.append(text[cursor:start])
        replacement = ""
        try:
            data = json.loads(payload)
        except (TypeError, ValueError):
            data = None
        if isinstance(data, dict) and isinstance(data.get("path"), str):
            replacement = _file_link(data["path"])
        result.append(replacement or text[start:marker_end])
        cursor = marker_end
    converted = "".join(result)

    # Newer Codex output may drop the private-use delimiters entirely, leaving
    # only a bare ``visualize{JSON}`` at the end of the message.
    bare = _trailing_bare_marker(converted)
    if bare is None:
        return converted
    start, end = bare
    replacement = _bare_marker_link(converted, start, end)
    if not replacement:
        return converted
    return converted[:start] + replacement


def convert_event_visualize_markers(event: dict) -> dict:
    """Return a copy of one stored event with Codex text markers converted.

    Only ``agent_message_chunk`` content text is touched, so history replay and
    the persisted message body stay consistent for the frontend interleaving
    path. Other event types and non-text payloads are returned unchanged.
    """
    if not isinstance(event, dict) or event.get("type") != "agent_message_chunk":
        return event
    data = event.get("data")
    if not isinstance(data, dict):
        return event
    content = data.get("content")
    if not isinstance(content, dict):
        return event
    text = content.get("text")
    if not isinstance(text, str):
        return event
    converted = convert_visualize_markers(text)
    if converted == text:
        return event
    result = dict(event)
    result["data"] = {**data, "content": {**content, "text": converted}}
    return result


class CodexVisualizeStream:
    """Buffer partial ``visualize`` markers across streaming text chunks."""

    def __init__(self) -> None:
        self._buffer = ""

    def feed(self, text: str) -> str:
        self._buffer += text
        return self._drain(final=False)

    def flush(self) -> str:
        return self._drain(final=True)

    def _drain(self, *, final: bool) -> str:
        emitted: list[str] = []
        while self._buffer:
            start = self._buffer.find(VISUALIZE_OPEN)
            if start < 0:
                bare = convert_visualize_markers(self._buffer)
                if bare != self._buffer:
                    emitted.append(bare)
                    self._buffer = ""
                    break
                bare_start = (
                    None if final else _trailing_bare_start(self._buffer)
                )
                if bare_start is not None:
                    emitted.append(self._buffer[:bare_start])
                    self._buffer = self._buffer[bare_start:]
                    break
                hold = 0 if final else max(
                    _partial_open_len(self._buffer),
                    _partial_bare_len(self._buffer),
                )
                if hold:
                    emitted.append(self._buffer[:-hold])
                    self._buffer = self._buffer[-hold:]
                else:
                    emitted.append(self._buffer)
                    self._buffer = ""
                break

            emitted.append(self._buffer[:start])
            open_end = start + len(VISUALIZE_OPEN)
            payload_start = _payload_start(self._buffer, open_end)
            end = self._buffer.find(VISUALIZE_END, payload_start)
            if end < 0:
                if final:
                    emitted.append(self._buffer[start:])
                    self._buffer = ""
                else:
                    self._buffer = self._buffer[start:]
                break

            marker = self._buffer[start:end + len(VISUALIZE_END)]
            emitted.append(convert_visualize_markers(marker))
            self._buffer = self._buffer[end + len(VISUALIZE_END):]
        return "".join(emitted)
