"""RFC 5389 async UDP STUN binding server (IPv4 and IPv6, zero-DB)."""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import struct
import time
from collections import deque

logger = logging.getLogger(__name__)

STUN_MAGIC_COOKIE = 0x2112A442
STUN_BINDING_REQUEST = 0x0001
STUN_BINDING_SUCCESS_RESPONSE = 0x0101
STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020
MAX_STUN_PACKET_BYTES = 1500


def build_stun_binding_response(tx_id: bytes, peer_ip: str, peer_port: int) -> bytes:
    """Build an RFC 5389 Binding Success Response with XOR-MAPPED-ADDRESS."""
    if len(tx_id) != 12:
        raise ValueError("STUN transaction id must be 12 bytes")
    address = ipaddress.ip_address(peer_ip)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped

    xport = peer_port ^ (STUN_MAGIC_COOKIE >> 16)
    if isinstance(address, ipaddress.IPv4Address):
        xaddr = int(address) ^ STUN_MAGIC_COOKIE
        attr_value = struct.pack("!BBHI", 0, 0x01, xport, xaddr)
    else:
        mask = struct.pack("!I", STUN_MAGIC_COOKIE) + tx_id
        xaddr_bytes = bytes(a ^ b for a, b in zip(address.packed, mask))
        attr_value = struct.pack("!BBH", 0, 0x02, xport) + xaddr_bytes

    attr = struct.pack("!HH", STUN_ATTR_XOR_MAPPED_ADDRESS, len(attr_value)) + attr_value
    header = struct.pack("!HHI", STUN_BINDING_SUCCESS_RESPONSE, len(attr), STUN_MAGIC_COOKIE) + tx_id
    return header + attr


def parse_stun_binding_request(data: bytes) -> bytes | None:
    """Validate an incoming packet and return its 12-byte transaction ID if valid."""
    if len(data) < 20 or len(data) > MAX_STUN_PACKET_BYTES:
        return None
    if (data[0] & 0xC0) != 0:
        return None
    msg_type, msg_len, cookie = struct.unpack("!HHI", data[:8])
    if msg_type != STUN_BINDING_REQUEST or cookie != STUN_MAGIC_COOKIE:
        return None
    if msg_len % 4 != 0 or 20 + msg_len != len(data):
        return None
    return data[8:20]


class _StunProtocol(asyncio.DatagramProtocol):
    def __init__(self, server: "StunServer") -> None:
        self._server = server
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self.transport = transport  # type: ignore[assignment]

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        if self.transport is None:
            return
        peer_ip = str(addr[0])
        peer_port = int(addr[1])
        if not self._server._allow_request(peer_ip):
            return
        tx_id = parse_stun_binding_request(data)
        if tx_id is None:
            return
        try:
            response = build_stun_binding_response(tx_id, peer_ip, peer_port)
        except ValueError:
            return
        self._server.responses_sent += 1
        self.transport.sendto(response, addr)

    def error_received(self, exc: Exception) -> None:
        logger.debug("STUN UDP error: %s", exc)


class StunServer:
    """Lightweight async UDP STUN server bound inside the event loop."""

    def __init__(
        self,
        *,
        host: str = "0.0.0.0",
        port: int = 3478,
        max_requests_per_window: int = 200,
        window_seconds: float = 10.0,
    ) -> None:
        self.host = host
        self.port = int(port)
        self.max_requests_per_window = max_requests_per_window
        self.window_seconds = window_seconds
        self.bound_port: int = 0
        self.responses_sent: int = 0
        self._transport: asyncio.DatagramTransport | None = None
        self._protocol: _StunProtocol | None = None
        self._rate_buckets: dict[str, deque[float]] = {}

    def _allow_request(self, peer_ip: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        bucket = self._rate_buckets.get(peer_ip)
        if bucket is None:
            if len(self._rate_buckets) >= 4096:
                self._prune_buckets(cutoff)
            bucket = deque()
            self._rate_buckets[peer_ip] = bucket
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= self.max_requests_per_window:
            return False
        bucket.append(now)
        return True

    def _prune_buckets(self, cutoff: float) -> None:
        stale = [ip for ip, q in self._rate_buckets.items() if not q or q[-1] < cutoff]
        for ip in stale:
            self._rate_buckets.pop(ip, None)

    async def start(self) -> int:
        if self._transport is not None:
            return self.bound_port
        loop = asyncio.get_running_loop()
        transport, protocol = await loop.create_datagram_endpoint(
            lambda: _StunProtocol(self),
            local_addr=(self.host, self.port),
        )
        self._transport = transport  # type: ignore[assignment]
        self._protocol = protocol
        sockname = transport.get_extra_info("sockname")
        self.bound_port = int(sockname[1]) if sockname else self.port
        return self.bound_port

    async def close(self) -> None:
        if self._transport is not None:
            self._transport.close()
            self._transport = None
            self._protocol = None
            self.bound_port = 0
