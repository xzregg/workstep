import pytest
from pydantic import ValidationError

from workstep_gateway_protocol import (
    ControlEnvelope,
    FrameType,
    ProxyFrame,
    UnsupportedProtocolVersion,
    assert_protocol_version,
)


def test_unknown_required_protocol_version_is_rejected():
    assert_protocol_version(1)
    with pytest.raises(UnsupportedProtocolVersion):
        assert_protocol_version(2)


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
