"""Plain inputs and results shared by API adapters and Gateway services.

These values contain dependencies, credentials, wire metadata and asynchronous
payload/socket ports. They never contain an ASGI application or request object.
"""

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Mapping, Protocol
from urllib.parse import SplitResult, urlsplit


class SocketClosed(Exception):
    pass


class SocketPort(Protocol):
    async def accept(self, *, subprotocol: str | None = None) -> None: ...
    async def close(self, code: int = 1000, reason: str | None = None) -> None: ...
    async def receive_json(self) -> Any: ...
    async def send_json(self, value: Any) -> None: ...
    async def receive(self) -> dict: ...
    async def send_text(self, value: str) -> None: ...
    async def send_bytes(self, value: bytes) -> None: ...


class ProofHeaders(dict):
    def __init__(self, values=()):
        super().__init__((key.lower(), value) for key, value in dict(values).items())

    def get(self, key, default=None):
        return super().get(key.lower(), default)


@dataclass(frozen=True)
class QueryValues(Mapping[str, str]):
    pairs: tuple[tuple[str, str], ...] = ()

    def get(self, name, default=None):
        return dict(self.pairs).get(name, default)

    def __len__(self):
        return len(dict(self.pairs))

    def multi_items(self):
        return self.pairs

    def __iter__(self):
        return iter(dict(self.pairs))

    def __getitem__(self, key):
        return dict(self.pairs)[key]


@dataclass
class GatewayDependencies:
    database: Any = None
    settings: Any = None
    gateway_signer: Any = None
    control_connections: Any = None
    identity_rate_limiter: Any = None
    identity_connectors: Any = None
    directory_callback_wake: Any = None
    directory_reconciler: Any = None
    protocol_version: Any = None
    command_scheduler_lock: Any = None
    usage_ledger_lock: Any = None
    usage_batch_slots: Any = None
    share_upload_slots: Any = None
    usage_batch_timeout_seconds: float = 10.0


@dataclass
class GatewayCall(GatewayDependencies):
    tokens: Mapping[str, str] = field(default_factory=dict)
    proofs: ProofHeaders = field(default_factory=ProofHeaders)
    target: SplitResult = field(default_factory=lambda: urlsplit("http://localhost/"))
    operation: str = "GET"
    peer: Any = None
    query_values: QueryValues = field(default_factory=QueryValues)
    wire_headers: tuple[tuple[bytes, bytes], ...] = ()
    payload: Callable[[], AsyncIterator[bytes]] | None = None
    callback_url: Callable[..., str] | None = None

    async def read_payload(self) -> bytes:
        return b"".join([chunk async for chunk in self.payload()])


@dataclass
class GatewaySocket(GatewayCall):
    port: SocketPort | None = None

    async def accept(self, *, subprotocol=None):
        await self.port.accept(subprotocol=subprotocol)

    async def close(self, code=1000, reason=None):
        if reason is None:
            await self.port.close(code=code)
        else:
            await self.port.close(code=code, reason=reason)

    async def receive_json(self):
        return await self.port.receive_json()

    async def send_json(self, value):
        await self.port.send_json(value)

    async def receive(self):
        return await self.port.receive()

    async def send_text(self, value):
        await self.port.send_text(value)

    async def send_bytes(self, value):
        await self.port.send_bytes(value)


@dataclass(frozen=True)
class CredentialGrant:
    key: str
    token: str | None = None
    lifetime: int | None = None


@dataclass
class ReplyEffects:
    phase: str | None = None
    grants: list[CredentialGrant] = field(default_factory=list)


class ReplyHeaders(dict):
    def __init__(self, values=()):
        super().__init__(values)
        self.extra: list[tuple[str, str]] = []

    def append(self, name, value):
        self.extra.append((name, value))


@dataclass
class JsonValue:
    content: Any
    headers: dict = field(default_factory=ReplyHeaders)
    grants: list[CredentialGrant] = field(default_factory=list)


@dataclass
class RawValue:
    content: str | bytes = b""
    media_type: str | None = None


@dataclass
class RedirectTarget:
    url: str
    headers: dict = field(default_factory=ReplyHeaders)
    grants: list[CredentialGrant] = field(default_factory=list)


@dataclass
class FileArtifact:
    path: Any
    media_type: str | None = None
    filename: str | None = None
    headers: dict = field(default_factory=ReplyHeaders)


@dataclass
class StreamPayload:
    chunks: AsyncIterator[bytes]
    status: int = 200
    headers: ReplyHeaders = field(default_factory=ReplyHeaders)
