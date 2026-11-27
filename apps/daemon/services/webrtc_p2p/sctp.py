"""Pure-Python SCTP (RFC 4960) + WebRTC DCEP (RFC 8832) over DTLS."""

from __future__ import annotations

import asyncio
import enum
import hashlib
import hmac
import logging
import secrets
import struct
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# WebRTC DataChannel SCTP Payload Protocol Identifiers (RFC 8831 / RFC 8832)
WEBRTC_DCEP = 50
WEBRTC_STRING = 51
WEBRTC_BINARY_PARTIAL = 52
WEBRTC_BINARY = 53
WEBRTC_STRING_PARTIAL = 54
WEBRTC_STRING_EMPTY = 56
WEBRTC_BINARY_EMPTY = 57

DCEP_DATA_CHANNEL_ACK = 0x02
DCEP_DATA_CHANNEL_OPEN = 0x03

MAX_SCTP_USER_PAYLOAD = 1100
DEFAULT_ARWND = 256 * 1024
DEFAULT_STREAMS = 65535
INITIAL_RTO = 0.35
MAX_RTO = 2.0


def _make_crc32c_table() -> tuple[int, ...]:
    poly = 0x82F63B78
    table = []
    for i in range(256):
        crc = i
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ poly
            else:
                crc >>= 1
        table.append(crc)
    return tuple(table)


_CRC32C_TABLE = _make_crc32c_table()


def crc32c(data: bytes) -> int:
    crc = 0xFFFFFFFF
    table = _CRC32C_TABLE
    for byte in data:
        crc = table[(crc ^ byte) & 0xFF] ^ (crc >> 8)
    return crc ^ 0xFFFFFFFF


class ChunkType(enum.IntEnum):
    DATA = 0
    INIT = 1
    INIT_ACK = 2
    SACK = 3
    HEARTBEAT = 4
    HEARTBEAT_ACK = 5
    ABORT = 6
    SHUTDOWN = 7
    SHUTDOWN_ACK = 8
    ERROR = 9
    COOKIE_ECHO = 10
    COOKIE_ACK = 11
    SHUTDOWN_COMPLETE = 14
    RE_CONFIG = 130


def _pad4(length: int) -> int:
    return (length + 3) & ~3


def _build_chunk(chunk_type: int, flags: int, body: bytes) -> bytes:
    header = struct.pack("!BBH", chunk_type, flags, 4 + len(body))
    pad = (-len(body)) % 4
    return header + body + (b"\x00" * pad)


def _parse_params(raw: bytes) -> list[tuple[int, bytes]]:
    params: list[tuple[int, bytes]] = []
    offset = 0
    while offset + 4 <= len(raw):
        ptype, plen = struct.unpack("!HH", raw[offset : offset + 4])
        if plen < 4 or offset + plen > len(raw):
            break
        params.append((ptype, raw[offset + 4 : offset + plen]))
        offset += _pad4(plen)
    return params


def _tsn_gt(a: int, b: int) -> bool:
    return ((a - b) & 0xFFFFFFFF) < 0x80000000 and a != b


def _tsn_le(a: int, b: int) -> bool:
    return a == b or _tsn_gt(b, a)


@dataclass
class _InflightChunk:
    tsn: int
    stream_id: int
    ssn: int
    ppid: int
    flags: int
    payload: bytes
    sent_at: float
    rto: float
    retries: int = 0

    def encode(self) -> bytes:
        body = struct.pack("!IHHI", self.tsn, self.stream_id, self.ssn, self.ppid) + self.payload
        return _build_chunk(ChunkType.DATA, self.flags, body)


class SctpAssociation:
    """Reliable, fragmented SCTP + DCEP association over a DTLS datagram transport."""

    def __init__(
        self,
        *,
        send_packet: Callable[[bytes], Awaitable[None]],
        on_datachannel_message: Callable[[int, int, bytes], Awaitable[None] | None] | None = None,
        on_channel_open: Callable[[int, str, str], Awaitable[None] | None] | None = None,
        local_port: int = 5000,
        remote_port: int = 5000,
    ) -> None:
        self._send_packet = send_packet
        self.on_datachannel_message = on_datachannel_message
        self.on_channel_open = on_channel_open
        self.local_port = local_port
        self.remote_port = remote_port

        self._local_tag = secrets.randbits(32) or 1
        self._remote_tag = 0
        self._local_tsn = secrets.randbits(32)
        self._remote_initial_tsn = 0
        self._cookie_secret = secrets.token_bytes(32)

        self._established = asyncio.Event()
        self._closed = False
        self._send_lock = asyncio.Lock()

        # Outbound tracking
        self._outbound_ssn: dict[int, int] = {}
        self._inflight: dict[int, _InflightChunk] = {}
        self._remote_arwnd = DEFAULT_ARWND
        self._retransmit_task: asyncio.Task | None = None

        # Inbound tracking
        self._cum_tsn: int | None = None
        self._ooo_chunks: dict[int, tuple[int, int, int, int, bytes]] = {}
        self._reassembly: dict[tuple[int, int], list[tuple[int, int, int, bytes]]] = {}
        self._open_channels: dict[int, str] = {}
        self._ack_waiters: dict[int, asyncio.Future[None]] = {}

    @property
    def established(self) -> bool:
        return self._established.is_set() and not self._closed

    def _pack_packet(self, verification_tag: int, chunks: list[bytes]) -> bytes:
        # RFC 4960 §6.8 / RFC 3309 encodes SCTP CRC32c in little-endian wire order.
        header = struct.pack("!HHI", self.local_port, self.remote_port, verification_tag) + b"\x00\x00\x00\x00"
        raw_zero = header + b"".join(chunks)
        checksum = crc32c(raw_zero)
        return header[:8] + struct.pack("<I", checksum) + raw_zero[12:]

    async def _send_chunks(self, verification_tag: int, chunks: list[bytes]) -> None:
        if self._closed:
            return
        packet = self._pack_packet(verification_tag, chunks)
        await self._send_packet(packet)

    async def connect(self) -> None:
        """Initiate SCTP association (send INIT and wait for COOKIE_ACK)."""
        self._start_retransmit_loop()
        init_body = struct.pack(
            "!IIHHI",
            self._local_tag,
            DEFAULT_ARWND,
            DEFAULT_STREAMS,
            DEFAULT_STREAMS,
            self._local_tsn,
        )
        # Advertise Forward-TSN Supported parameter (0xC000) for clean WebRTC peer negotiation.
        init_body += struct.pack("!HH", 0xC000, 4)
        init_chunk = _build_chunk(ChunkType.INIT, 0, init_body)
        for _ in range(8):
            if self._established.is_set() or self._closed:
                break
            await self._send_chunks(0, [init_chunk])
            try:
                await asyncio.wait_for(self._established.wait(), timeout=0.4)
                return
            except asyncio.TimeoutError:
                continue
        if not self._established.is_set():
            raise TimeoutError("SCTP connect handshake timed out")

    async def accept(self) -> None:
        """Wait for remote peer to establish the SCTP association."""
        self._start_retransmit_loop()
        await self._established.wait()
        if self._closed:
            raise ConnectionError("SCTP association closed during accept")

    def _start_retransmit_loop(self) -> None:
        if self._retransmit_task is None:
            self._retransmit_task = asyncio.create_task(self._retransmit_loop())

    async def _retransmit_loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(0.1)
                now = time.monotonic()
                resend: list[_InflightChunk] = []
                async with self._send_lock:
                    for chunk in self._inflight.values():
                        if now - chunk.sent_at >= chunk.rto:
                            chunk.sent_at = now
                            chunk.rto = min(MAX_RTO, chunk.rto * 1.5)
                            chunk.retries += 1
                            resend.append(chunk)
                for chunk in resend[:16]:
                    await self._send_chunks(self._remote_tag, [chunk.encode()])
        except asyncio.CancelledError:
            pass

    def _sign_cookie(self, peer_tag: int, peer_tsn: int) -> bytes:
        body = struct.pack("!II", peer_tag, peer_tsn)
        mac = hmac.new(self._cookie_secret, body, hashlib.sha256).digest()
        return body + mac

    def _verify_cookie(self, cookie: bytes) -> tuple[int, int] | None:
        if len(cookie) != 40:
            return None
        body, mac = cookie[:8], cookie[8:]
        expected = hmac.new(self._cookie_secret, body, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, expected):
            return None
        return struct.unpack("!II", body)

    async def handle_incoming_packet(self, data: bytes) -> None:
        if self._closed or len(data) < 12:
            return
        src_port, dst_port, vtag = struct.unpack("!HHI", data[:8])
        checksum = struct.unpack("<I", data[8:12])[0]
        zero_pkt = data[:8] + b"\x00\x00\x00\x00" + data[12:]
        actual_crc = crc32c(zero_pkt)
        if actual_crc != checksum:
            logger.debug("SCTP CRC32c mismatch rx=0x%08x calc=0x%08x len=%d", checksum, actual_crc, len(data))
            return
        if self.remote_port == 5000 and src_port:
            self.remote_port = src_port

        offset = 12
        events_to_emit: list[tuple[int, int, bytes]] = []
        channels_to_emit: list[tuple[int, str, str]] = []
        send_sack = False

        while offset + 4 <= len(data):
            ctype, cflags, clen = struct.unpack("!BBH", data[offset : offset + 4])
            if clen < 4 or offset + clen > len(data):
                break
            body = data[offset + 4 : offset + clen]
            offset += _pad4(clen)

            if ctype == ChunkType.INIT:
                if len(body) < 16:
                    continue
                peer_tag, _arwnd, _os, _mis, peer_tsn = struct.unpack("!IIHHI", body[:16])
                if peer_tag == 0:
                    continue
                self._remote_tag = peer_tag
                self._remote_initial_tsn = peer_tsn
                self._cum_tsn = (peer_tsn - 1) & 0xFFFFFFFF
                cookie = self._sign_cookie(peer_tag, peer_tsn)
                ack_body = struct.pack(
                    "!IIHHI",
                    self._local_tag,
                    DEFAULT_ARWND,
                    DEFAULT_STREAMS,
                    DEFAULT_STREAMS,
                    self._local_tsn,
                ) + struct.pack("!HH", 0x0007, 4 + len(cookie)) + cookie + (b"\x00" * ((-len(cookie)) % 4))
                await self._send_chunks(peer_tag, [_build_chunk(ChunkType.INIT_ACK, 0, ack_body)])

            elif ctype == ChunkType.INIT_ACK:
                if len(body) < 16:
                    continue
                peer_tag, peer_arwnd, _os, _mis, peer_tsn = struct.unpack("!IIHHI", body[:16])
                self._remote_tag = peer_tag
                self._remote_arwnd = peer_arwnd
                self._remote_initial_tsn = peer_tsn
                self._cum_tsn = (peer_tsn - 1) & 0xFFFFFFFF
                for ptype, pval in _parse_params(body[16:]):
                    if ptype == 0x0007:
                        await self._send_chunks(peer_tag, [_build_chunk(ChunkType.COOKIE_ECHO, 0, pval)])
                        break

            elif ctype == ChunkType.COOKIE_ECHO:
                parsed = self._verify_cookie(body)
                if parsed is not None:
                    peer_tag, peer_tsn = parsed
                    self._remote_tag = peer_tag
                    if self._cum_tsn is None:
                        self._cum_tsn = (peer_tsn - 1) & 0xFFFFFFFF
                    await self._send_chunks(peer_tag, [_build_chunk(ChunkType.COOKIE_ACK, 0, b"")])
                    self._established.set()

            elif ctype == ChunkType.COOKIE_ACK:
                self._established.set()

            elif ctype == ChunkType.HEARTBEAT:
                await self._send_chunks(self._remote_tag, [_build_chunk(ChunkType.HEARTBEAT_ACK, 0, body)])

            elif ctype == ChunkType.SACK:
                if len(body) < 12:
                    continue
                cum_ack, arwnd, num_gaps, _num_dups = struct.unpack("!IIHH", body[:12])
                self._remote_arwnd = arwnd
                acked_tsns: list[int] = []
                async with self._send_lock:
                    for tsn in list(self._inflight):
                        if _tsn_le(tsn, cum_ack):
                            acked_tsns.append(tsn)
                    gap_offset = 12
                    for _ in range(num_gaps):
                        if gap_offset + 4 > len(body):
                            break
                        g_start, g_end = struct.unpack("!HH", body[gap_offset : gap_offset + 4])
                        gap_offset += 4
                        for offset_val in range(g_start, g_end + 1):
                            acked_tsns.append((cum_ack + offset_val) & 0xFFFFFFFF)
                    for tsn in acked_tsns:
                        self._inflight.pop(tsn, None)

            elif ctype == ChunkType.DATA:
                if len(body) < 12:
                    continue
                tsn, stream_id, ssn, ppid = struct.unpack("!IHHI", body[:12])
                user_data = body[12:]
                send_sack = True
                self._ingest_data_chunk(tsn, cflags, stream_id, ssn, ppid, user_data, events_to_emit, channels_to_emit)

            elif ctype == ChunkType.RE_CONFIG:
                # Acknowledge RFC 6525 stream reset requests cleanly.
                if len(body) >= 8:
                    params = _parse_params(body)
                    for _ptype, pval in params:
                        if len(pval) >= 4:
                            seq = struct.unpack("!I", pval[:4])[0]
                            resp_param = struct.pack("!HHII", 0x0010, 12, seq, 1)
                            await self._send_chunks(self._remote_tag, [_build_chunk(ChunkType.RE_CONFIG, 0, resp_param)])

            elif ctype == ChunkType.SHUTDOWN:
                await self._send_chunks(self._remote_tag, [_build_chunk(ChunkType.SHUTDOWN_ACK, 0, b"")])
                self._closed = True
                self._established.set()

            elif ctype in (ChunkType.ABORT, ChunkType.SHUTDOWN_ACK, ChunkType.SHUTDOWN_COMPLETE, ChunkType.ERROR):
                logger.debug("SCTP control chunk type=%d body=%s", ctype, body.hex())
                if ctype == ChunkType.SHUTDOWN_ACK:
                    await self._send_chunks(self._remote_tag, [_build_chunk(ChunkType.SHUTDOWN_COMPLETE, 0, b"")])
                if ctype != ChunkType.ERROR:
                    self._closed = True
                    self._established.set()

        if send_sack and self._cum_tsn is not None and not self._closed:
            await self._send_sack()

        for sid, label, protocol in channels_to_emit:
            if self.on_channel_open is not None:
                res = self.on_channel_open(sid, label, protocol)
                if asyncio.iscoroutine(res):
                    await res

        for sid, ppid, payload in events_to_emit:
            if ppid == WEBRTC_DCEP:
                await self._handle_dcep(sid, payload, channels_to_emit)
                continue
            if self.on_datachannel_message is not None:
                res = self.on_datachannel_message(sid, ppid, payload)
                if asyncio.iscoroutine(res):
                    await res

    def _ingest_data_chunk(
        self,
        tsn: int,
        flags: int,
        stream_id: int,
        ssn: int,
        ppid: int,
        user_data: bytes,
        events_out: list[tuple[int, int, bytes]],
        _channels_out: list[tuple[int, str, str]],
    ) -> None:
        if self._cum_tsn is None:
            self._cum_tsn = (tsn - 1) & 0xFFFFFFFF
        if _tsn_le(tsn, self._cum_tsn):
            return
        self._ooo_chunks.setdefault(tsn, (flags, stream_id, ssn, ppid, user_data))

        while True:
            next_tsn = (self._cum_tsn + 1) & 0xFFFFFFFF
            item = self._ooo_chunks.pop(next_tsn, None)
            if item is None:
                break
            self._cum_tsn = next_tsn
            c_flags, c_sid, c_ssn, c_ppid, c_data = item
            begin_bit = bool(c_flags & 0x02)
            end_bit = bool(c_flags & 0x01)
            if begin_bit and end_bit:
                events_out.append((c_sid, c_ppid, c_data))
                continue
            key = (c_sid, c_ssn)
            buf = self._reassembly.setdefault(key, [])
            buf.append((next_tsn, c_flags, c_ppid, c_data))
            if end_bit:
                parts = self._reassembly.pop(key, [])
                full_data = b"".join(part[3] for part in parts)
                first_ppid = parts[0][2] if parts else c_ppid
                events_out.append((c_sid, first_ppid, full_data))

    async def _send_sack(self) -> None:
        assert self._cum_tsn is not None
        gaps: list[tuple[int, int]] = []
        if self._ooo_chunks:
            offsets = sorted((tsn - self._cum_tsn) & 0xFFFFFFFF for tsn in self._ooo_chunks)
            start = end = offsets[0]
            for val in offsets[1:]:
                if val == end + 1:
                    end = val
                else:
                    if start <= 0xFFFF and end <= 0xFFFF:
                        gaps.append((start, end))
                    start = end = val
            if start <= 0xFFFF and end <= 0xFFFF:
                gaps.append((start, end))
        body = struct.pack("!IIHH", self._cum_tsn, DEFAULT_ARWND, len(gaps), 0)
        for g_start, g_end in gaps:
            body += struct.pack("!HH", g_start, g_end)
        await self._send_chunks(self._remote_tag, [_build_chunk(ChunkType.SACK, 0, body)])

    async def _handle_dcep(self, stream_id: int, payload: bytes, _channels_out: list[tuple[int, str, str]]) -> None:
        if not payload:
            return
        msg_type = payload[0]
        if msg_type == DCEP_DATA_CHANNEL_OPEN and len(payload) >= 12:
            _msg_type, _channel_type, _priority, _reliability, label_len, proto_len = struct.unpack("!BBHIHH", payload[:12])
            offset = 12
            label = payload[offset : offset + label_len].decode("utf-8", errors="replace")
            offset += label_len
            protocol = payload[offset : offset + proto_len].decode("utf-8", errors="replace")
            self._open_channels[stream_id] = label
            await self._send_user_message(stream_id, WEBRTC_DCEP, bytes([DCEP_DATA_CHANNEL_ACK]))
            if self.on_channel_open is not None:
                res = self.on_channel_open(stream_id, label, protocol)
                if asyncio.iscoroutine(res):
                    await res
        elif msg_type == DCEP_DATA_CHANNEL_ACK:
            waiter = self._ack_waiters.pop(stream_id, None)
            if waiter is not None and not waiter.done():
                waiter.set_result(None)

    async def open_channel(self, *, stream_id: int, label: str, protocol: str = "") -> None:
        loop = asyncio.get_running_loop()
        waiter: asyncio.Future[None] = loop.create_future()
        self._ack_waiters[stream_id] = waiter
        label_b = label.encode("utf-8")
        proto_b = protocol.encode("utf-8")
        header = struct.pack("!BBHIHH", DCEP_DATA_CHANNEL_OPEN, 0x00, 0, 0, len(label_b), len(proto_b))
        await self._send_user_message(stream_id, WEBRTC_DCEP, header + label_b + proto_b)
        await asyncio.wait_for(waiter, timeout=5.0)
        self._open_channels[stream_id] = label

    async def send_datachannel_text(self, *, stream_id: int, text: str) -> None:
        encoded = text.encode("utf-8")
        if not encoded:
            await self._send_user_message(stream_id, WEBRTC_STRING_EMPTY, b"\x00")
            return
        await self._send_user_message(stream_id, WEBRTC_STRING, encoded)

    async def send_datachannel_bytes(self, *, stream_id: int, data: bytes) -> None:
        if not data:
            await self._send_user_message(stream_id, WEBRTC_BINARY_EMPTY, b"\x00")
            return
        await self._send_user_message(stream_id, WEBRTC_BINARY, data)

    async def _send_user_message(self, stream_id: int, ppid: int, data: bytes) -> None:
        if not self.established:
            raise ConnectionError("SCTP association is not open")
        slices = [
            data[i : i + MAX_SCTP_USER_PAYLOAD] or b""
            for i in range(0, max(1, len(data)), MAX_SCTP_USER_PAYLOAD)
        ]
        if not data:
            slices = [b""]

        encoded_chunks: list[bytes] = []
        async with self._send_lock:
            ssn = self._outbound_ssn.get(stream_id, 0)
            self._outbound_ssn[stream_id] = (ssn + 1) & 0xFFFF
            now = time.monotonic()
            total = len(slices)
            for idx, part in enumerate(slices):
                flags = 0
                if idx == 0:
                    flags |= 0x02  # B-bit
                if idx == total - 1:
                    flags |= 0x01  # E-bit
                tsn = self._local_tsn
                self._local_tsn = (self._local_tsn + 1) & 0xFFFFFFFF
                chunk = _InflightChunk(
                    tsn=tsn,
                    stream_id=stream_id,
                    ssn=ssn,
                    ppid=ppid,
                    flags=flags,
                    payload=part,
                    sent_at=now,
                    rto=INITIAL_RTO,
                )
                self._inflight[tsn] = chunk
                encoded_chunks.append(chunk.encode())

        # Send immediately in bounded batches to stay safely below path MTU.
        for chunk_bytes in encoded_chunks:
            while len(self._inflight) > 256 and not self._closed:
                await asyncio.sleep(0.005)
            await self._send_chunks(self._remote_tag, [chunk_bytes])

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._retransmit_task is not None:
            self._retransmit_task.cancel()
            self._retransmit_task = None
        for waiter in self._ack_waiters.values():
            if not waiter.done():
                waiter.cancel()
        self._ack_waiters.clear()
        self._established.set()
