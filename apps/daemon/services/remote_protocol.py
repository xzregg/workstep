"""HTTP-shaped request and response values for remote project transport."""

import json
from dataclasses import dataclass, field
from typing import Any

REMOTE_REQUEST_BODY_LIMIT = 64 * 1024 * 1024


@dataclass(frozen=True)
class RemoteHttpRequest:
    request_id: str
    method: str
    path: str
    query: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    # Attribution supplied by the authenticated forwarding daemon, not headers.
    actor: dict[str, str] | None = None


@dataclass(frozen=True)
class RemoteHttpResponse:
    request_id: str
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body)
