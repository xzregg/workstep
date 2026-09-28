import pytest
from pydantic import ValidationError

from workstep_gateway_protocol import (
    ControlEnvelope,
    FrameType,
    ProxyFrame,
    UnsupportedProtocolVersion,
    assert_protocol_version,
    websocket_payloads,
    WebSocketMessageAssembler,
    project_http_route_allowed,
)


def test_unknown_required_protocol_version_is_rejected():
    assert_protocol_version(1)
    with pytest.raises(UnsupportedProtocolVersion):
        assert_protocol_version(2)


def test_project_http_allowlist_matches_only_the_bound_project():
    allowed = project_http_route_allowed
    assert allowed("GET", "/api/project/host-1/summary", [], "host-1")
    assert not allowed("GET", "/api/project/host-2/summary", [], "host-1")
    assert allowed("GET", "/api/task/list", [("project_id", "host-1")], "host-1")
    assert allowed("GET", "/api/task/task-1", [("project_id", "host-1")], "host-1")
    assert not allowed("GET", "/api/task/task-1", [("project_id", "host-2")], "host-1")
    assert not allowed("GET", "/api/task/task-1", [
        ("project_id", "host-1"), ("project_id", "host-2")], "host-1")
    assert not allowed("POST", "/api/task/task-1", [("project_id", "host-1")], "host-1")
    assert not allowed("GET", "/api/project/list", [("project_id", "host-1")], "host-1")


def test_control_envelope_requires_known_version_and_target():
    message = ControlEnvelope(
        version=1, message_id="message-1", kind="heartbeat", device_id="device-1",
        sent_at="2026-09-28T00:00:00Z", payload={},
    )
    assert message.device_id == "device-1"
    with pytest.raises(ValidationError):
        ControlEnvelope.model_validate({**message.model_dump(), "version": 2})


def test_proxy_frame_has_typed_stream_identifier():
    frame = ProxyFrame(stream_id="stream-1", type=FrameType.http_request, payload={})
    assert frame.stream_id == "stream-1"
    with pytest.raises(ValidationError):
        ProxyFrame(stream_id="", type=FrameType.http_request, payload={})


def test_websocket_messages_are_chunked_and_reassembled_with_size_limit():
    message = b"hello" * 20000
    payloads = list(websocket_payloads("bytes", message))
    assert len(payloads) > 1
    assert all(len(payload["data"]) < 30000 for payload in payloads)
    assembler = WebSocketMessageAssembler()
    assert all(assembler.add(payload) is None for payload in payloads[:-1])
    assert assembler.add(payloads[-1]) == ("bytes", message)
    with pytest.raises(ValueError):
        assembler.add({"kind": "text", "data": "%%%", "final": True})
