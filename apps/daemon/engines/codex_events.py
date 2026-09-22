"""Codex transport event normalization shared by CLI and SDK adapters.

Codex CLI and the Codex SDK expose a wider set of notifications than WorkStep's
ACP-aligned ``InternalEvent`` vocabulary.  Known WorkStep-relevant events are
mapped by the adapters to ACP events; this module classifies the remaining
native events into stable ``acp_raw`` payloads so realtime and replay paths
never depend on transport-specific shapes.

The output is intentionally not an A2UI conversion.  A2UI is reserved for UI
surface payloads; diagnostics, lifecycle notices, and runtime metadata remain
AG-UI ``CUSTOM workstep.acp_raw`` events.
"""

from __future__ import annotations

from typing import Any, Mapping

from engines.core.events import InternalEvent, native_unmapped_event


CODEX_RAW_CATEGORIES: dict[str, str] = {
    "account/login/completed": "account",
    "account/rateLimits/updated": "account",
    "account/updated": "account",
    "app/list/updated": "catalog",
    "command/exec/outputDelta": "process",
    "configWarning": "configuration",
    "deprecationNotice": "diagnostic",
    "externalAgentConfig/import/completed": "configuration",
    "externalAgentConfig/import/progress": "configuration",
    "fs/changed": "filesystem",
    "fuzzyFileSearch/sessionCompleted": "search",
    "fuzzyFileSearch/sessionUpdated": "search",
    "guardianWarning": "warning",
    "hook/completed": "hook",
    "hook/started": "hook",
    "item/autoApprovalReview/completed": "approval_review",
    "item/autoApprovalReview/started": "approval_review",
    "item/commandExecution/terminalInteraction": "tool",
    "item/fileChange/patchUpdated": "tool",
    "item/reasoning/summaryPartAdded": "reasoning",
    "mcpServer/oauthLogin/completed": "mcp",
    "mcpServer/startupStatus/updated": "mcp",
    "model/rerouted": "model",
    "model/safetyBuffering/updated": "model",
    "model/verification": "model",
    "process/exited": "process",
    "process/outputDelta": "process",
    "remoteControl/status/changed": "remote_control",
    "serverRequest/resolved": "interaction",
    "skills/changed": "skills",
    "thread/archived": "thread",
    "thread/closed": "thread",
    "thread/deleted": "thread",
    "thread/environment/connected": "environment",
    "thread/environment/disconnected": "environment",
    "thread/goal/cleared": "goal",
    "thread/goal/updated": "goal",
    "thread/realtime/closed": "realtime",
    "thread/realtime/error": "realtime",
    "thread/realtime/itemAdded": "realtime",
    "thread/realtime/outputAudio/delta": "realtime",
    "thread/realtime/sdp": "realtime",
    "thread/realtime/started": "realtime",
    "thread/realtime/transcript/delta": "realtime",
    "thread/realtime/transcript/done": "realtime",
    "thread/settings/updated": "settings",
    "thread/started": "thread",
    "thread/status/changed": "status",
    "thread/unarchived": "thread",
    "turn/diff/updated": "diff",
    "turn/moderationMetadata": "moderation",
    "warning": "warning",
    "windows/worldWritableWarning": "warning",
    "windowsSandbox/setupCompleted": "sandbox",
}

# Native fields that are safe to expose on the normalized envelope.  The full
# payload remains under ``raw`` for replay fidelity; these aliases let the UI or
# diagnostics consume common metadata without knowing each transport schema.
_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "thread_id": ("threadId", "thread_id"),
    "turn_id": ("turnId", "turn_id"),
    "item_id": ("itemId", "item_id"),
    "process_id": ("processId", "process_id"),
    "request_id": ("requestId", "request_id"),
    "review_id": ("reviewId", "review_id"),
    "session_id": ("sessionId", "session_id"),
    "environment_id": ("environmentId", "environment_id"),
    "name": ("name", "thread_name", "threadName"),
    "status": ("status",),
}


def _read(payload: Mapping[str, Any], names: tuple[str, ...]) -> Any:
    for name in names:
        if name in payload and payload[name] is not None:
            return payload[name]
    return None


def _plain(value: Any) -> Any:
    """Return a JSON-friendly value without importing transport SDK types."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            return dump(by_alias=False, exclude_none=True)
        except TypeError:
            return dump()
    if isinstance(value, Mapping):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    enum_value = getattr(value, "value", None)
    if enum_value is not None and not isinstance(enum_value, (str, int, float, bool)):
        return enum_value
    if hasattr(value, "__dict__"):
        return {
            str(key): _plain(item)
            for key, item in vars(value).items()
            if not str(key).startswith("_")
        }
    return str(value)


def _payload_dict(payload: Any) -> dict[str, Any]:
    if payload is None:
        return {}
    if isinstance(payload, Mapping):
        return dict(payload)
    dumped = _plain(payload)
    return dumped if isinstance(dumped, dict) else {"value": dumped}


def codex_raw_event(method: str, payload: Any = None) -> InternalEvent:
    """Normalize one unmapped Codex event into the shared ``acp_raw`` shape."""
    method = str(method or "unknown")
    raw = _payload_dict(payload)
    envelope: dict[str, Any] = {
        "method": method,
        "category": CODEX_RAW_CATEGORIES.get(method, "unknown"),
    }
    for target, aliases in _FIELD_ALIASES.items():
        value = _read(raw, aliases)
        if value is not None:
            envelope[target] = _plain(value)
    event = native_unmapped_event(method, payload)
    event.data.update(envelope)
    return event


def codex_cli_raw_event(event: Mapping[str, Any]) -> InternalEvent:
    """Normalize an unrecognized Codex CLI JSONL event."""
    method = str(event.get("type") or "unknown")
    return codex_raw_event(method, event)

