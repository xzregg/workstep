"""aioice + DTLS + SCTP peer session with strict non-relay enforcement."""

from __future__ import annotations

import asyncio
import logging
import os
import struct
from collections.abc import Awaitable, Callable
from ipaddress import ip_address
from typing import Any
from urllib.parse import urlsplit

import aioice
from aioice.ice import server_reflexive_candidate

from workstep_gateway_protocol.webrtc import is_direct_candidate_type, is_relay_candidate_line

from .bridge import WebRtcDataBridge
from .dtls import DtlsTransport, EphemeralCertificate, generate_ephemeral_certificate
from .sctp import (
    WEBRTC_BINARY,
    WEBRTC_BINARY_EMPTY,
    WEBRTC_STRING,
    WEBRTC_STRING_EMPTY,
    SctpAssociation,
)
from .sdp import (
    RelayCandidateInSdpError,
    build_datachannel_answer_sdp,
    choose_dtls_answer_setup,
    parse_datachannel_offer_sdp,
)

logger = logging.getLogger(__name__)


class RelayCandidateRejected(ValueError):
    """Raised when ICE selects or advertises a TURN relay candidate in direct-only mode."""


def parse_stun_servers(stun_urls: list[str]) -> list[tuple[str, int]]:
    """Extract all usable STUN (host, port) tuples from ICE server URLs preserving order."""
    servers: list[tuple[str, int]] = []
    for raw in stun_urls:
        url = raw.strip()
        if not url.lower().startswith("stun:"):
            continue
        parsed = urlsplit("stun://" + url[5:].lstrip("/"))
        host = parsed.hostname
        if not host:
            continue
        entry = (host, int(parsed.port or 3478))
        if entry not in servers:
            servers.append(entry)
    return servers


def parse_stun_server(stun_urls: list[str]) -> tuple[str, int] | None:
    """Extract the first usable STUN (host, port) tuple from ICE server URLs."""
    servers = parse_stun_servers(stun_urls)
    return servers[0] if servers else None


async def select_reachable_stun_server(
    stun_urls: list[str],
    *,
    timeout: float = 1.2,
) -> tuple[str, int] | None:
    """Concurrently race RFC 5389 Binding requests and return the fastest reachable STUN server."""
    servers = parse_stun_servers(stun_urls)
    if not servers:
        return None
    loop = asyncio.get_running_loop()
    winner: asyncio.Future[tuple[str, int] | None] = loop.create_future()
    transports: list[asyncio.DatagramTransport] = []
    remaining = len(servers)

    class _ProbeProtocol(asyncio.DatagramProtocol):
        def __init__(self, target: tuple[str, int], tx_id: bytes) -> None:
            self._target = target
            self._tx_id = tx_id

        def datagram_received(self, data: bytes, _addr: tuple[str, int]) -> None:
            if len(data) < 20 or winner.done():
                return
            msg_type, _msg_len, cookie = struct.unpack("!HHI", data[:8])
            if msg_type == 0x0101 and cookie == 0x2112A442 and data[8:20] == self._tx_id:
                winner.set_result(self._target)

    async def _probe_one(target: tuple[str, int]) -> None:
        nonlocal remaining
        tx_id = os.urandom(12)
        packet = struct.pack("!HHI", 0x0001, 0, 0x2112A442) + tx_id
        transport: asyncio.DatagramTransport | None = None
        try:
            transport, _ = await loop.create_datagram_endpoint(
                lambda: _ProbeProtocol(target, tx_id),
                remote_addr=target,
            )
            transports.append(transport)
            while not winner.done():
                transport.sendto(packet)
                await asyncio.sleep(0.25)
        except OSError:
            remaining -= 1
            if remaining == 0 and not winner.done():
                winner.set_result(None)

    tasks = [asyncio.create_task(_probe_one(server)) for server in servers]
    try:
        return await asyncio.wait_for(asyncio.shield(winner), timeout=timeout)
    except asyncio.TimeoutError:
        return None
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for transport in transports:
            transport.close()


def verify_direct_candidate_pair(pair: Any) -> dict[str, Any]:
    """Verify that the nominated ICE candidate pair uses no TURN relay on either side."""
    if pair is None:
        raise RelayCandidateRejected("No ICE candidate pair was nominated")
    local = getattr(pair, "local_candidate", None)
    remote = getattr(pair, "remote_candidate", None)
    local_type = str(getattr(local, "type", "") or "").lower()
    remote_type = str(getattr(remote, "type", "") or "").lower()
    if not is_direct_candidate_type(local_type) or not is_direct_candidate_type(remote_type):
        raise RelayCandidateRejected(
            f"Direct P2P required, but ICE nominated relay/unsupported pair ({local_type} -> {remote_type})"
        )
    return {
        "local_type": local_type,
        "local_address": f"{getattr(local, 'host', '')}:{getattr(local, 'port', 0)}",
        "remote_type": remote_type,
        "remote_address": f"{getattr(remote, 'host', '')}:{getattr(remote, 'port', 0)}",
    }


def _strip_candidate_prefix(candidate: str) -> str:
    raw = candidate.strip()
    if raw.startswith("a="):
        raw = raw[2:]
    if raw.startswith("candidate:"):
        raw = raw[len("candidate:") :]
    return raw


class WebRtcPeerSession:
    """Manages one remote WebRTC DataChannel peer connection."""

    def __init__(
        self,
        *,
        session_id: str,
        device_id: str,
        expected_ticket: str,
        verify_pair_key: Callable[[str], Awaitable[bool]],
        stun_urls: list[str],
        asgi_app: Any,
        send_signal: Callable[[dict[str, Any]], Awaitable[None]],
        on_closed: Callable[[str], None] | None = None,
    ) -> None:
        self.session_id = session_id
        self.device_id = device_id
        self.expected_ticket = expected_ticket
        self._verify_pair_key = verify_pair_key
        self.stun_urls = list(stun_urls)
        self.asgi_app = asgi_app
        self._send_signal = send_signal
        self._on_closed = on_closed

        self._cert: EphemeralCertificate = generate_ephemeral_certificate()
        self.ice: aioice.Connection | None = None
        self.dtls: DtlsTransport | None = None
        self.sctp: SctpAssociation | None = None
        self.bridge: WebRtcDataBridge | None = None
        self.candidate_info: dict[str, Any] | None = None

        self._primary_stream_id: int = 0
        self._runner_task: asyncio.Task | None = None
        self._recv_task: asyncio.Task | None = None
        self._local_trickle_task: asyncio.Task | None = None
        self._local_trickle_done = True
        self._remote_end_received = False
        self._closed = False

    async def accept_offer(self, offer_sdp: str, *, trickle_answer: bool = False) -> str:
        """Parse remote offer, gather non-relay ICE candidates, and return SDP answer."""
        offer = parse_datachannel_offer_sdp(offer_sdp)
        if any(is_relay_candidate_line(candidate) for candidate in offer.candidates):
            raise RelayCandidateRejected("Relay candidate rejected in direct-only mode")
        self._local_trickle_done = not trickle_answer
        stun_server = None if trickle_answer else await select_reachable_stun_server(self.stun_urls)
        self.ice = aioice.Connection(
            ice_controlling=False,
            components=1,
            stun_server=stun_server,
            turn_server=None,
            use_ipv4=True,
            use_ipv6=True,
        )
        self.ice.remote_username = offer.ice_ufrag
        self.ice.remote_password = offer.ice_pwd

        await self.ice.gather_candidates()
        local_candidates: list[str] = []
        for candidate in self.ice.local_candidates:
            if str(candidate.type).lower() == "relay":
                continue
            local_candidates.append(f"candidate:{candidate.to_sdp()}")

        _, dtls_role = choose_dtls_answer_setup(offer.setup)
        answer_sdp = build_datachannel_answer_sdp(
            offer=offer,
            local_ufrag=self.ice.local_username,
            local_pwd=self.ice.local_password,
            local_fingerprint=self._cert.fingerprint,
            local_candidates=local_candidates,
            sctp_port=offer.sctp_port,
            max_message_size=min(offer.max_message_size, 262144),
            session_id=self.session_id[:12] or "1",
            end_of_candidates=not trickle_answer,
        )
        self._runner_task = asyncio.create_task(self._run_transport(offer, dtls_role))
        return answer_sdp

    def start_trickle_answer(self) -> None:
        self._local_trickle_task = asyncio.create_task(self._trickle_local_candidates())

    async def _trickle_local_candidates(self) -> None:
        ice = self.ice
        assert ice is not None
        tasks: list[asyncio.Task] = []
        try:
            server = await select_reachable_stun_server(self.stun_urls, timeout=3.0)
            if server is not None:
                # Query STUN on the same sockets that are already handling ICE checks.
                tasks = [
                    asyncio.create_task(server_reflexive_candidate(protocol, server))
                    for protocol in ice._protocols
                    if ip_address(protocol.local_candidate.host).version == 4
                ]
                try:
                    async with asyncio.timeout(5.0):
                        for result in asyncio.as_completed(tasks):
                            try:
                                candidate, _ = await result
                            except (OSError, ValueError, KeyError, aioice.stun.TransactionError):
                                continue
                            await self._send_local_candidate(f"candidate:{candidate.to_sdp()}")
                except asyncio.TimeoutError:
                    pass
            await self._send_local_candidate(None)
        except Exception as exc:
            logger.debug("Could not complete WebRTC candidate signaling: %s", type(exc).__name__)
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self._local_trickle_done = True
            if not self._closed and self._remote_end_received:
                await self.add_remote_candidate(None)

    async def _send_local_candidate(self, candidate: str | None) -> None:
        await self._send_signal({
            "type": "ice_candidate", "session_id": self.session_id, "candidate": candidate,
        })

    async def add_remote_candidate(self, candidate: str | None) -> None:
        if self.ice is None or self._closed:
            return
        if getattr(self.ice, "_remote_candidates_end", False):
            return
        if candidate is None or not candidate.strip():
            self._remote_end_received = True
            if self._local_trickle_done:
                await self.ice.add_remote_candidate(None)
            return
        if is_relay_candidate_line(candidate):
            raise RelayCandidateRejected("Relay candidate rejected in direct-only mode")
        raw = _strip_candidate_prefix(candidate)
        await self.ice.add_remote_candidate(aioice.Candidate.from_sdp(raw))

    async def _run_transport(self, offer, dtls_role: str) -> None:
        assert self.ice is not None
        candidate_tasks: list[asyncio.Task] = []
        try:
            for cand_str in offer.candidates:
                parsed = aioice.Candidate.from_sdp(_strip_candidate_prefix(cand_str))
                if parsed.host.endswith(".local"):
                    candidate_tasks.append(asyncio.create_task(self.ice.add_remote_candidate(parsed)))
                else:
                    await self.ice.add_remote_candidate(parsed)

            await asyncio.wait_for(self.ice.connect(), timeout=20.0)
            nominated = self.ice._nominated.get(1)
            self.candidate_info = verify_direct_candidate_pair(nominated)
            logger.info(
                "WebRTC direct ICE connected session=%s local=%s remote=%s",
                self.session_id,
                self.candidate_info["local_type"],
                self.candidate_info["remote_type"],
            )

            self.dtls = DtlsTransport(
                role=dtls_role,
                certificate=self._cert,
                remote_fingerprint=offer.fingerprint,
                send_packet=self.ice.send,
            )
            self.sctp = SctpAssociation(
                send_packet=self.dtls.send_application_data,
                local_port=offer.sctp_port,
                remote_port=offer.sctp_port,
            )
            self.bridge = WebRtcDataBridge(
                app=self.asgi_app,
                device_id=self.device_id,
                expected_ticket=self.expected_ticket,
                verify_pair_key=self._verify_pair_key,
                candidate_info=self.candidate_info,
                send_text=lambda text: self.sctp.send_datachannel_text(stream_id=self._primary_stream_id, text=text),
                send_bytes=lambda raw: self.sctp.send_datachannel_bytes(stream_id=self._primary_stream_id, data=raw),
            )
            self.dtls.on_application_data = self.sctp.handle_incoming_packet
            self.sctp.on_channel_open = self._on_channel_open
            self.sctp.on_datachannel_message = self._on_datachannel_message

            self._recv_task = asyncio.create_task(self._ice_recv_loop())
            logger.debug("WebRTC session=%s starting DTLS handshake role=%s", self.session_id, dtls_role)
            await asyncio.wait_for(self.dtls.handshake(), timeout=15.0)
            logger.debug("WebRTC session=%s DTLS handshake done, starting SCTP", self.session_id)
            if dtls_role == "client":
                await asyncio.wait_for(self.sctp.connect(), timeout=15.0)
            else:
                await asyncio.wait_for(self.sctp.accept(), timeout=15.0)
            logger.debug("WebRTC session=%s SCTP established", self.session_id)
            await asyncio.wait_for(self.bridge.authenticated.wait(), timeout=10.0)
            if self._local_trickle_task is not None:
                self._local_trickle_task.cancel()
            await self._recv_task
        except RelayCandidateRejected as exc:
            logger.warning("WebRTC direct-only check rejected session=%s: %s", self.session_id, exc)
            try:
                await self._send_signal({
                    "type": "error",
                    "session_id": self.session_id,
                    "code": "relay_not_allowed",
                    "message": str(exc),
                })
            except Exception:
                pass
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug(
                "WebRTC session %s ended (%s): %s",
                self.session_id,
                type(exc).__name__,
                exc,
                exc_info=True,
            )
        finally:
            for task in candidate_tasks:
                task.cancel()
            if candidate_tasks:
                await asyncio.gather(*candidate_tasks, return_exceptions=True)
            await self.close()

    def _on_channel_open(self, stream_id: int, label: str, _protocol: str) -> None:
        if label == "workstep-proxy-v1" or self._primary_stream_id == 0:
            self._primary_stream_id = stream_id

    async def _on_datachannel_message(self, stream_id: int, ppid: int, payload: bytes) -> None:
        if self.bridge is None:
            return
        self._primary_stream_id = stream_id
        if ppid == WEBRTC_STRING:
            await self.bridge.handle_text(payload.decode("utf-8"))
        elif ppid == WEBRTC_STRING_EMPTY:
            await self.bridge.handle_text("")
        elif ppid == WEBRTC_BINARY:
            await self.bridge.handle_bytes(payload)
        elif ppid == WEBRTC_BINARY_EMPTY:
            await self.bridge.handle_bytes(b"")

    async def _ice_recv_loop(self) -> None:
        assert self.ice is not None and self.dtls is not None
        while not self._closed:
            data = await self.ice.recv()
            if not data:
                continue
            # RFC 7983 demultiplexing: DTLS packets carry content types 20..63.
            if 20 <= data[0] <= 63:
                await self.dtls.handle_incoming_packet(data)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._local_trickle_task is not None:
            self._local_trickle_task.cancel()
        if self._recv_task is not None and self._recv_task is not asyncio.current_task():
            self._recv_task.cancel()
        if self._runner_task is not None and self._runner_task is not asyncio.current_task():
            self._runner_task.cancel()
        if self.bridge is not None:
            await self.bridge.close()
        if self.sctp is not None:
            await self.sctp.close()
        if self.dtls is not None:
            await self.dtls.close()
        if self.ice is not None:
            try:
                await self.ice.close()
            except Exception:
                pass
        if self._on_closed is not None:
            self._on_closed(self.session_id)
