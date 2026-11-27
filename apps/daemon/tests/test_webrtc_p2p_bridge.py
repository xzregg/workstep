"""Tests for WebRTC DTLS/SCTP/DataChannel stack, direct-only ICE enforcement, and ASGI bridge."""

from __future__ import annotations

import asyncio
import hashlib
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from starlette.responses import StreamingResponse

from workstep_gateway_protocol import FrameType, ProxyFrame
from workstep_gateway_protocol.webrtc import (
    DataChannelBinaryKind,
    decode_binary_frame,
    encode_binary_frame,
)


def test_sdp_offer_answer_and_direct_candidate_validation():
    from services.webrtc_p2p.dtls import generate_ephemeral_certificate
    from services.webrtc_p2p.peer import RelayCandidateRejected, verify_direct_candidate_pair
    from services.webrtc_p2p.sdp import build_datachannel_answer_sdp, parse_datachannel_offer_sdp

    cert = generate_ephemeral_certificate()
    offer_sdp = "\r\n".join([
        "v=0",
        "o=- 12345 2 IN IP4 127.0.0.1",
        "s=-",
        "t=0 0",
        "a=group:BUNDLE 0",
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
        "c=IN IP4 0.0.0.0",
        "a=ice-ufrag:ufragOffer",
        "a=ice-pwd:pwdOfferSecretValue123456",
        f"a=fingerprint:sha-256 {cert.fingerprint}",
        "a=setup:actpass",
        "a=mid:0",
        "a=sctp-port:5000",
        "a=max-message-size:262144",
        "a=candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host",
        "",
    ])
    parsed = parse_datachannel_offer_sdp(offer_sdp)
    assert parsed.mid == "0"
    assert parsed.ice_ufrag == "ufragOffer"
    assert parsed.ice_pwd == "pwdOfferSecretValue123456"
    assert parsed.fingerprint == cert.fingerprint
    assert parsed.sctp_port == 5000
    assert parsed.setup == "actpass"
    assert len(parsed.candidates) == 1

    answer = build_datachannel_answer_sdp(
        offer=parsed,
        local_ufrag="ufragAns",
        local_pwd="pwdAnswerSecretValue12345",
        local_fingerprint=cert.fingerprint,
        local_candidates=["candidate:1 1 udp 2122260223 192.168.1.20 40000 typ host"],
        sctp_port=5000,
    )
    assert "m=application 9 UDP/DTLS/SCTP webrtc-datachannel" in answer
    assert "a=setup:passive" in answer
    assert "a=mid:0" in answer
    assert "a=end-of-candidates" in answer

    # Direct candidate pairs pass
    ok_pair = SimpleNamespace(
        local_candidate=SimpleNamespace(type="host", host="192.168.1.20", port=40000),
        remote_candidate=SimpleNamespace(type="srflx", host="198.51.100.2", port=62000),
    )
    info = verify_direct_candidate_pair(ok_pair)
    assert info["local_type"] == "host"
    assert info["remote_type"] == "srflx"

    # Relay candidate on either side must raise
    relay_pair = SimpleNamespace(
        local_candidate=SimpleNamespace(type="host", host="192.168.1.20", port=40000),
        remote_candidate=SimpleNamespace(type="relay", host="203.0.113.5", port=3478),
    )
    with pytest.raises(RelayCandidateRejected):
        verify_direct_candidate_pair(relay_pair)


def test_sctp_header_crc32c_little_endian():
    import struct
    from services.webrtc_p2p.sctp import SctpAssociation, crc32c

    async def noop(_data: bytes) -> None:
        return None

    assoc = SctpAssociation(send_packet=noop)
    pkt = assoc._pack_packet(0x11223344, [b"\x01\x00\x00\x08\xaa\xbb\xcc\xdd"])
    expected_crc = crc32c(pkt[:8] + b"\x00\x00\x00\x00" + pkt[12:])
    assert struct.unpack("<I", pkt[8:12])[0] == expected_crc


@pytest.mark.asyncio
async def test_dtls_handshake_and_sctp_fragmented_datachannel_roundtrip():
    from services.webrtc_p2p.dtls import DtlsTransport, generate_ephemeral_certificate
    from services.webrtc_p2p.sctp import SctpAssociation

    client_cert = generate_ephemeral_certificate()
    server_cert = generate_ephemeral_certificate()

    client_to_server: asyncio.Queue[bytes] = asyncio.Queue()
    server_to_client: asyncio.Queue[bytes] = asyncio.Queue()

    client_dtls = DtlsTransport(
        role="client",
        certificate=client_cert,
        remote_fingerprint=server_cert.fingerprint,
        send_packet=client_to_server.put,
    )
    server_dtls = DtlsTransport(
        role="server",
        certificate=server_cert,
        remote_fingerprint=client_cert.fingerprint,
        send_packet=server_to_client.put,
    )

    async def pump(queue: asyncio.Queue[bytes], target: DtlsTransport):
        while True:
            pkt = await queue.get()
            await target.handle_incoming_packet(pkt)

    t1 = asyncio.create_task(pump(client_to_server, server_dtls))
    t2 = asyncio.create_task(pump(server_to_client, client_dtls))
    try:
        await asyncio.gather(
            asyncio.wait_for(client_dtls.handshake(), timeout=3.0),
            asyncio.wait_for(server_dtls.handshake(), timeout=3.0),
        )

        # Wire SCTP associations over the established DTLS channels
        server_sctp_rx: asyncio.Queue[tuple[int, int, bytes]] = asyncio.Queue()
        client_sctp_rx: asyncio.Queue[tuple[int, int, bytes]] = asyncio.Queue()

        client_sctp = SctpAssociation(
            send_packet=client_dtls.send_application_data,
            on_datachannel_message=lambda sid, ppid, data: client_sctp_rx.put_nowait((sid, ppid, data)),
        )
        server_sctp = SctpAssociation(
            send_packet=server_dtls.send_application_data,
            on_datachannel_message=lambda sid, ppid, data: server_sctp_rx.put_nowait((sid, ppid, data)),
        )
        client_dtls.on_application_data = client_sctp.handle_incoming_packet
        server_dtls.on_application_data = server_sctp.handle_incoming_packet

        await asyncio.gather(
            asyncio.wait_for(client_sctp.connect(), timeout=3.0),
            asyncio.wait_for(server_sctp.accept(), timeout=3.0),
        )

        # Send a fragmented large binary message (> 32 KiB) via DCEP channel 0
        await client_sctp.open_channel(stream_id=0, label="workstep-proxy-v1")
        large_payload = bytes((idx % 251) for idx in range(40_000))
        await client_sctp.send_datachannel_bytes(stream_id=0, data=large_payload)

        # Server should see DCEP ACK already sent and receive full reassembled payload
        received = []
        while True:
            sid, ppid, payload = await asyncio.wait_for(server_sctp_rx.get(), timeout=3.0)
            if ppid == 53:
                received.append((sid, payload))
                break
        assert received == [(0, large_payload)]
        await client_sctp.close()
        await server_sctp.close()
    finally:
        t1.cancel()
        t2.cancel()
        await asyncio.gather(t1, t2, return_exceptions=True)
        await client_dtls.close()
        await server_dtls.close()


@pytest.mark.asyncio
async def test_webrtc_data_bridge_http_streaming_websocket_and_desktop_security(monkeypatch):
    from api.desktop_security import DesktopSecurityMiddleware
    from services.webrtc_p2p.bridge import WebRtcDataBridge

    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "secret-desktop-token")

    app = FastAPI()
    app.add_middleware(DesktopSecurityMiddleware)

    @app.get("/api/ping")
    async def ping(request: Request):
        actor = request.scope.get("webrtc_remote_actor")
        return {"ok": True, "actor_id": actor.user_id if actor else None, "q": request.query_params.get("v")}

    @app.post("/api/upload-echo")
    async def upload_echo(request: Request):
        raw = await request.body()
        return {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}

    @app.get("/api/stream-file")
    async def stream_file():
        async def chunks():
            for idx in range(16):
                yield bytes([65 + idx]) * 16384

        return StreamingResponse(chunks(), media_type="application/octet-stream")

    @app.get("/api/fs/open-directory")
    async def open_dir():
        return {"opened": True}

    @app.get("/api/project/init")
    async def init_project():
        return {"inited": True}

    @app.post("/custom-feature/echo")
    async def custom_feature_echo(request: Request):
        return {"custom_path": request.url.path, "body": (await request.body()).decode("utf-8")}

    @app.websocket("/ws")
    async def ws_echo(ws: WebSocket):
        await ws.accept()
        try:
            while True:
                msg = await ws.receive_text()
                await ws.send_text(f"echo:{msg}")
        except WebSocketDisconnect:
            pass

    @app.websocket("/ws-custom/stream")
    async def ws_custom_echo(ws: WebSocket):
        await ws.accept()
        try:
            while True:
                msg = await ws.receive_text()
                await ws.send_text(f"custom:{msg}")
        except WebSocketDisconnect:
            pass

    outbound_text: asyncio.Queue[dict] = asyncio.Queue()
    outbound_bin: asyncio.Queue[bytes] = asyncio.Queue()

    async def send_text(text: str):
        await outbound_text.put(json.loads(text))

    async def send_bytes(raw: bytes):
        await outbound_bin.put(raw)

    bridge = WebRtcDataBridge(
        app=app,
        device_id="dev-1",
        expected_ticket="ticket-xyz",
        verify_pair_key=lambda key: asyncio.sleep(0, result=key == "local-secret-1234567890-abcdef"),
        candidate_info={"local_type": "host", "remote_type": "srflx"},
        send_text=send_text,
        send_bytes=send_bytes,
    )

    # Wrong ticket is rejected
    await bridge.handle_text(json.dumps({"type": "p2p.auth", "ticket": "wrong"}))
    auth_err = await asyncio.wait_for(outbound_text.get(), timeout=1.0)
    assert auth_err["type"] == "p2p.error"

    # A valid ticket and the host secret unlock the bridge
    await bridge.handle_text(json.dumps({"type": "p2p.auth", "ticket": "ticket-xyz", "pair_key": "local-secret-1234567890-abcdef"}))
    ready = await asyncio.wait_for(outbound_text.get(), timeout=1.0)
    assert ready["type"] == "p2p.ready"
    assert ready["candidate_info"] == {"local_type": "host", "remote_type": "srflx"}

    # 1) Standard GET with query params passes DesktopSecurityMiddleware without desktop token
    await bridge.handle_text(ProxyFrame(
        stream_id="s-get",
        type=FrameType.http_request,
        payload={"phase": "start", "method": "GET", "path": "/api/ping", "query": "v=42", "headers": []},
    ).model_dump_json())
    await bridge.handle_text(ProxyFrame(
        stream_id="s-get",
        type=FrameType.http_request,
        payload={"phase": "end"},
    ).model_dump_json())

    res_start = await asyncio.wait_for(outbound_text.get(), timeout=1.0)
    assert res_start["stream_id"] == "s-get"
    assert res_start["payload"]["status"] == 200
    body_buf = bytearray()
    while True:
        # Response bodies arrive as binary frames for efficiency
        if not outbound_bin.empty():
            kind, sid, _final, chunk = decode_binary_frame(outbound_bin.get_nowait())
            assert sid == "s-get"
            assert kind == DataChannelBinaryKind.http_response_body
            body_buf.extend(chunk)
        frame = await asyncio.wait_for(outbound_text.get(), timeout=1.0)
        if frame["stream_id"] == "s-get" and frame["payload"].get("phase") == "end":
            break
    while not outbound_bin.empty():
        _, sid, _, chunk = decode_binary_frame(outbound_bin.get_nowait())
        if sid == "s-get":
            body_buf.extend(chunk)
    assert json.loads(body_buf.decode()) == {"ok": True, "actor_id": "webrtc-p2p", "q": "42"}

    # 2) Native desktop-only paths remain blocked for remote peers; project init allowed for device owner
    for path, expected_status in (("/api/fs/open-directory", 403), ("/api/project/init", 200)):
        sid = f"s-{path}"
        await bridge.handle_text(ProxyFrame(
            stream_id=sid,
            type=FrameType.http_request,
            payload={"phase": "start", "method": "GET", "path": path, "query": "", "headers": []},
        ).model_dump_json())
        await bridge.handle_text(ProxyFrame(
            stream_id=sid, type=FrameType.http_request, payload={"phase": "end"},
        ).model_dump_json())
        while True:
            frame = await asyncio.wait_for(outbound_text.get(), timeout=1.0)
            if frame["stream_id"] == sid and frame["payload"].get("phase") == "start":
                assert frame["payload"]["status"] == expected_status
            if frame["stream_id"] == sid and frame["payload"].get("phase") == "end":
                break
        while not outbound_bin.empty():
            outbound_bin.get_nowait()

    # 3) Large binary upload via compact binary frames
    upload_data = b"workstep-upload-" * 4000
    await bridge.handle_text(ProxyFrame(
        stream_id="s-up",
        type=FrameType.http_request,
        payload={"phase": "start", "method": "POST", "path": "/api/upload-echo", "query": "", "headers": []},
    ).model_dump_json())
    await bridge.handle_bytes(encode_binary_frame(DataChannelBinaryKind.http_request_body, "s-up", upload_data, final=True))
    up_body = bytearray()
    while True:
        frame = await asyncio.wait_for(outbound_text.get(), timeout=1.0)
        if frame["stream_id"] == "s-up" and frame["payload"].get("phase") == "end":
            break
    while not outbound_bin.empty():
        _, sid, _, chunk = decode_binary_frame(outbound_bin.get_nowait())
        if sid == "s-up":
            up_body.extend(chunk)
    assert json.loads(up_body.decode()) == {
        "size": len(upload_data),
        "sha256": hashlib.sha256(upload_data).hexdigest(),
    }

    # 4) Streaming download with window_update credit flow control (256 KiB)
    await bridge.handle_text(ProxyFrame(
        stream_id="s-dl",
        type=FrameType.http_request,
        payload={"phase": "start", "method": "GET", "path": "/api/stream-file", "query": "", "headers": []},
    ).model_dump_json())
    await bridge.handle_text(ProxyFrame(
        stream_id="s-dl", type=FrameType.http_request, payload={"phase": "end"},
    ).model_dump_json())
    dl_buf = bytearray()
    got_end = False
    while not got_end:
        # Drain text and binary frames and return window credits
        while not outbound_bin.empty():
            _, sid, _, chunk = decode_binary_frame(outbound_bin.get_nowait())
            if sid == "s-dl":
                dl_buf.extend(chunk)
                await bridge.handle_text(ProxyFrame(
                    stream_id="s-dl", type=FrameType.window_update, payload={"credits": 1},
                ).model_dump_json())
        try:
            frame = await asyncio.wait_for(outbound_text.get(), timeout=0.05)
            if frame["stream_id"] == "s-dl" and frame["payload"].get("phase") == "end":
                got_end = True
        except asyncio.TimeoutError:
            pass
    while not outbound_bin.empty():
        _, sid, _, chunk = decode_binary_frame(outbound_bin.get_nowait())
        if sid == "s-dl":
            dl_buf.extend(chunk)
    assert len(dl_buf) == 16 * 16384

    # 5) WebSocket multiplexing over the same bridge
    await bridge.handle_text(ProxyFrame(
        stream_id="s-ws",
        type=FrameType.websocket_open,
        payload={"path": "/ws", "query": "", "headers": []},
    ).model_dump_json())
    ws_open = await asyncio.wait_for(outbound_text.get(), timeout=1.0)
    assert ws_open["type"] == FrameType.websocket_open
    assert ws_open["payload"]["accepted"] is True

    await bridge.handle_bytes(encode_binary_frame(DataChannelBinaryKind.websocket_data_text, "s-ws", b"hello-p2p", final=True))
    kind, sid, final, ws_msg = decode_binary_frame(await asyncio.wait_for(outbound_bin.get(), timeout=1.0))
    assert (kind, sid, final, ws_msg) == (DataChannelBinaryKind.websocket_data_text, "s-ws", True, b"echo:hello-p2p")

    await bridge.handle_text(ProxyFrame(
        stream_id="s-ws", type=FrameType.websocket_close, payload={"code": 1000},
    ).model_dump_json())

    async def next_frame(stream_id: str) -> dict:
        while True:
            item = await asyncio.wait_for(outbound_text.get(), timeout=1.0)
            if item.get("stream_id") == stream_id:
                return item

    # 6) Non-/api custom HTTP and non-/ws custom WebSocket paths pass through identically
    await bridge.handle_text(ProxyFrame(
        stream_id="s-custom-http",
        type=FrameType.http_request,
        payload={"phase": "start", "method": "POST", "path": "/custom-feature/echo", "query": "", "headers": []},
    ).model_dump_json())
    await bridge.handle_bytes(encode_binary_frame(DataChannelBinaryKind.http_request_body, "s-custom-http", b"arbitrary-payload", final=True))
    custom_start = await next_frame("s-custom-http")
    assert custom_start["payload"]["status"] == 200
    custom_end = await next_frame("s-custom-http")
    assert custom_end["payload"]["phase"] == "end"
    custom_chunks = bytearray()
    while not outbound_bin.empty():
        _, sid, _, chunk = decode_binary_frame(outbound_bin.get_nowait())
        if sid == "s-custom-http":
            custom_chunks.extend(chunk)
    assert json.loads(custom_chunks.decode()) == {"custom_path": "/custom-feature/echo", "body": "arbitrary-payload"}

    await bridge.handle_text(ProxyFrame(
        stream_id="s-ws-custom",
        type=FrameType.websocket_open,
        payload={"path": "/ws-custom/stream", "query": "", "headers": []},
    ).model_dump_json())
    ws_custom_open = await next_frame("s-ws-custom")
    assert ws_custom_open["payload"]["accepted"] is True
    await bridge.handle_bytes(encode_binary_frame(DataChannelBinaryKind.websocket_data_text, "s-ws-custom", b"any-ws", final=True))
    c_kind, c_sid, c_final, c_msg = decode_binary_frame(await asyncio.wait_for(outbound_bin.get(), timeout=1.0))
    assert (c_kind, c_sid, c_final, c_msg) == (DataChannelBinaryKind.websocket_data_text, "s-ws-custom", True, b"custom:any-ws")
    await bridge.handle_text(ProxyFrame(
        stream_id="s-ws-custom", type=FrameType.websocket_close, payload={"code": 1000},
    ).model_dump_json())
    await bridge.close()


@pytest.mark.asyncio
async def test_select_reachable_stun_server_races_and_skips_unreachable():
    import socket
    import time
    from services.webrtc_p2p.peer import parse_stun_servers, select_reachable_stun_server
    from workstep_webrtc_signal.stun import StunServer

    assert parse_stun_servers([
        "stun:stun.miwifi.com:3478",
        "stun:stun.l.google.com:19302",
    ]) == [("stun.miwifi.com", 3478), ("stun.l.google.com", 19302)]

    # Single entry returns immediately without probing
    assert await select_reachable_stun_server(["stun:127.0.0.1:49999"]) == ("127.0.0.1", 49999)

    dead_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dead_sock.bind(("127.0.0.1", 0))
    dead_port = dead_sock.getsockname()[1]

    live_stun = StunServer(host="127.0.0.1", port=0)
    live_port = await live_stun.start()
    try:
        started = time.monotonic()
        chosen = await select_reachable_stun_server(
            [f"stun:127.0.0.1:{dead_port}", f"stun:127.0.0.1:{live_port}"],
            timeout=0.8,
        )
        elapsed = time.monotonic() - started
        assert chosen == ("127.0.0.1", live_port)
        assert elapsed < 0.5

        # All-silent fallback returns first candidate instead of crashing
        dead2 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        dead2.bind(("127.0.0.1", 0))
        try:
            fallback = await select_reachable_stun_server(
                [f"stun:127.0.0.1:{dead_port}", f"stun:127.0.0.1:{dead2.getsockname()[1]}"],
                timeout=0.08,
            )
            assert fallback == ("127.0.0.1", dead_port)
        finally:
            dead2.close()
    finally:
        await live_stun.close()
        dead_sock.close()
