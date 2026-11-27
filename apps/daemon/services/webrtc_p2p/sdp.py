"""SDP parsing and generation for UDP/DTLS/SCTP webrtc-datachannel sessions."""

from __future__ import annotations

from dataclasses import dataclass

from workstep_gateway_protocol.webrtc import is_relay_candidate_line


class SdpError(ValueError):
    pass


class RelayCandidateInSdpError(SdpError):
    pass


@dataclass(frozen=True)
class DataChannelOffer:
    mid: str
    ice_ufrag: str
    ice_pwd: str
    fingerprint: str
    setup: str
    sctp_port: int
    max_message_size: int
    candidates: tuple[str, ...]


def parse_datachannel_offer_sdp(sdp: str) -> DataChannelOffer:
    """Parse an application-only WebRTC DataChannel SDP offer."""
    if not isinstance(sdp, str) or not sdp.strip():
        raise SdpError("Empty SDP offer")

    in_app = False
    mid = "0"
    ice_ufrag = ""
    ice_pwd = ""
    fingerprint = ""
    setup = "actpass"
    sctp_port = 5000
    max_message_size = 262144
    candidates: list[str] = []

    for raw_line in sdp.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("m="):
            in_app = line.startswith("m=application ") and "webrtc-datachannel" in line
            continue
        if line.startswith("a=ice-ufrag:") and (in_app or not ice_ufrag):
            ice_ufrag = line.split(":", 1)[1].strip()
        elif line.startswith("a=ice-pwd:") and (in_app or not ice_pwd):
            ice_pwd = line.split(":", 1)[1].strip()
        elif line.startswith("a=fingerprint:") and (in_app or not fingerprint):
            rest = line.split(":", 1)[1].strip()
            parts = rest.split(None, 1)
            if len(parts) != 2 or parts[0].lower() != "sha-256":
                raise SdpError("Only sha-256 DTLS fingerprint is supported")
            fingerprint = parts[1].strip().upper()
        elif in_app and line.startswith("a=mid:"):
            mid = line.split(":", 1)[1].strip() or "0"
        elif in_app and line.startswith("a=setup:"):
            setup = line.split(":", 1)[1].strip().lower()
        elif in_app and line.startswith("a=sctp-port:"):
            sctp_port = int(line.split(":", 1)[1].strip())
        elif in_app and line.startswith("a=max-message-size:"):
            max_message_size = int(line.split(":", 1)[1].strip())
        elif line.startswith("a=candidate:"):
            candidate_value = line[2:]
            if is_relay_candidate_line(candidate_value):
                raise RelayCandidateInSdpError("Relay candidate in SDP is forbidden in direct-only mode")
            if in_app:
                candidates.append(candidate_value)

    if not ice_ufrag or not ice_pwd or not fingerprint:
        raise SdpError("SDP offer is missing required ICE or DTLS attributes")

    return DataChannelOffer(
        mid=mid,
        ice_ufrag=ice_ufrag,
        ice_pwd=ice_pwd,
        fingerprint=fingerprint,
        setup=setup,
        sctp_port=sctp_port,
        max_message_size=max_message_size,
        candidates=tuple(candidates),
    )


def choose_dtls_answer_setup(offer_setup: str) -> tuple[str, str]:
    """Return (sdp_setup_value, local_dtls_role) for the SDP answer."""
    normalized = offer_setup.strip().lower()
    if normalized == "passive":
        return "active", "client"
    return "passive", "server"


def build_datachannel_answer_sdp(
    *,
    offer: DataChannelOffer,
    local_ufrag: str,
    local_pwd: str,
    local_fingerprint: str,
    local_candidates: list[str],
    sctp_port: int = 5000,
    max_message_size: int = 262144,
    session_id: str = "1",
) -> str:
    """Build an SDP answer for a pure DataChannel session without TURN."""
    answer_setup, _ = choose_dtls_answer_setup(offer.setup)
    lines = [
        "v=0",
        f"o=- {session_id} 2 IN IP4 127.0.0.1",
        "s=-",
        "t=0 0",
        f"a=group:BUNDLE {offer.mid}",
        "a=msid-semantic: WMS",
        f"m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
        "c=IN IP4 0.0.0.0",
        f"a=ice-ufrag:{local_ufrag}",
        f"a=ice-pwd:{local_pwd}",
        "a=ice-options:trickle",
        f"a=fingerprint:sha-256 {local_fingerprint.upper()}",
        f"a=setup:{answer_setup}",
        f"a=mid:{offer.mid}",
        f"a=sctp-port:{sctp_port}",
        f"a=max-message-size:{max_message_size}",
    ]
    for candidate in local_candidates:
        if is_relay_candidate_line(candidate):
            raise RelayCandidateInSdpError("Refusing to emit relay candidate in direct-only mode")
        prefix = "" if candidate.startswith("a=") else "a="
        lines.append(f"{prefix}{candidate}")
    lines.append("a=end-of-candidates")
    lines.append("")
    return "\r\n".join(lines)
