"""Generate WorkStep business IDs with a sortable millisecond suffix."""

import re
import secrets
import threading
import time
import uuid
from typing import Literal

_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
_PROJECT_ID = re.compile(r"[0-9a-f]{8}")
_SUFFIX_LENGTH = 18
_COUNTER_BITS = 40
_COUNTER_LIMIT = 1 << _COUNTER_BITS
_lock = threading.Lock()
_last_timestamp_ms = -1
_last_counter = 0


def new_id(
    project_id: str | None = None, *, kind: Literal["project"] | None = None,
) -> str:
    """Return a project ID, a project-scoped ID or an unscoped time ID."""
    global _last_timestamp_ms, _last_counter

    if kind == "project":
        return uuid.uuid4().hex[:8]

    with _lock:
        timestamp_ms = time.time_ns() // 1_000_000
        if timestamp_ms > _last_timestamp_ms:
            counter = secrets.randbits(_COUNTER_BITS)
        else:
            timestamp_ms = _last_timestamp_ms
            counter = _last_counter + 1
            if counter == _COUNTER_LIMIT:
                timestamp_ms += 1
                counter = 0
        _last_timestamp_ms, _last_counter = timestamp_ms, counter

    value = (timestamp_ms << _COUNTER_BITS) | counter
    suffix = "".join(
        _ALPHABET[(value >> (position * 5)) & 31]
        for position in reversed(range(_SUFFIX_LENGTH))
    )
    if not project_id:
        return suffix
    if _PROJECT_ID.fullmatch(project_id):
        return project_id + suffix
    # Registered legacy projects keep their complete, stable identifier.
    return f"{project_id}-{suffix}"
