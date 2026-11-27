"""Tests for the RFC 5389 async UDP STUN binding server."""

from __future__ import annotations

import asyncio
import ipaddress
import struct

import pytest

from workstep_webrtc_signal.stun import StunServer

MAGIC_COOKIE = 0x2112A442


def _build_binding_request(tx_id: bytes) -> bytes:
    return struct.pack("!HHI", 0x0001, 0, MAGIC_COOKIE) + tx_id


def _parse_xor_mapped_address(response: bytes, tx_id: bytes) -> tuple[str, int]:
    msg_type, msg_len, cookie = struct.unpack("!HHI", response[:8])
    assert msg_type == 0x0101
    assert cookie == MAGIC_COOKIE
    assert response[8:20] == tx_id
    offset = 20
    end = 20 + msg_len
    while offset + 4 <= end:
        attr_type, attr_len = struct.unpack("!HH", response[offset : offset + 4])
        offset += 4
        value = response[offset : offset + attr_len]
        offset += (attr_len + 3) & ~3
        if attr_type == 0x0020:
            family = value[1]
            xport = struct.unpack("!H", value[2:4])[0]
            port = xport ^ (MAGIC_COOKIE >> 16)
            if family == 0x01:
                xaddr = struct.unpack("!I", value[4:8])[0]
                ip = str(ipaddress.IPv4Address(xaddr ^ MAGIC_COOKIE))
                return ip, port
            if family == 0x02:
                mask = struct.pack("!I", MAGIC_COOKIE) + tx_id
                raw = bytes(a ^ b for a, b in zip(value[4:20], mask))
                return str(ipaddress.IPv6Address(raw)), port
    raise AssertionError("XOR-MAPPED-ADDRESS not found in STUN response")


class _UdpProbe(asyncio.DatagramProtocol):
    def __init__(self) -> None:
        self.transport: asyncio.DatagramTransport | None = None
        self.responses: asyncio.Queue[bytes] = asyncio.Queue()

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self.transport = transport  # type: ignore[assignment]

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        self.responses.put_nowait(data)


@pytest.mark.asyncio
async def test_stun_server_returns_xor_mapped_address_for_udp_client():
    server = StunServer(host="127.0.0.1", port=0)
    await server.start()
    loop = asyncio.get_running_loop()
    transport, client = await loop.create_datagram_endpoint(_UdpProbe, local_addr=("127.0.0.1", 0))
    try:
        assert server.bound_port > 0
        local_ip, local_port = transport.get_extra_info("sockname")
        tx_id = b"0123456789ab"
        transport.sendto(_build_binding_request(tx_id), ("127.0.0.1", server.bound_port))
        data = await asyncio.wait_for(client.responses.get(), timeout=2.0)
        mapped_ip, mapped_port = _parse_xor_mapped_address(data, tx_id)
        assert mapped_ip == local_ip
        assert mapped_port == local_port
    finally:
        transport.close()
        await server.close()


@pytest.mark.asyncio
async def test_stun_server_ignores_malformed_and_rate_limited_packets():
    server = StunServer(host="127.0.0.1", port=0, max_requests_per_window=3, window_seconds=10.0)
    await server.start()
    loop = asyncio.get_running_loop()
    transport, client = await loop.create_datagram_endpoint(_UdpProbe, local_addr=("127.0.0.1", 0))
    try:
        # Malformed packet should be silently dropped without breaking subsequent valid requests.
        transport.sendto(b"not-stun", ("127.0.0.1", server.bound_port))
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(client.responses.get(), timeout=0.15)

        for idx in range(2):
            tx_id = f"tx-valid-{idx:03d}".encode()
            transport.sendto(_build_binding_request(tx_id), ("127.0.0.1", server.bound_port))
            data = await asyncio.wait_for(client.responses.get(), timeout=2.0)
            assert data[8:20] == tx_id

        # Third request within window should be rate-limited.
        transport.sendto(_build_binding_request(b"tx-limited-1"), ("127.0.0.1", server.bound_port))
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(client.responses.get(), timeout=0.15)
    finally:
        transport.close()
        await server.close()
