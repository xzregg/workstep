"""Canonical gateway origins with narrowly scoped HTTP exceptions."""

from ipaddress import ip_address, ip_network
from urllib.parse import urlsplit


def is_loopback_hostname(host: str) -> bool:
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


_PRIVATE_NETWORKS = tuple(
    ip_network(network)
    for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")
)


def is_private_gateway_hostname(host: str) -> bool:
    """Return whether a host may use plaintext HTTP for a gateway connection."""
    if is_loopback_hostname(host):
        return True
    try:
        address = ip_address(host)
    except ValueError:
        return False
    return any(address in network for network in _PRIVATE_NETWORKS)


def validate_gateway_origin(value: str) -> str:
    return _validate_origin(value, remote_http=False)


def validate_daemon_origin(value: str) -> str:
    """Validate the user's browser entry, including mobile HTTP/LAN access.

    This is a callback destination, not the Gateway's trusted signing origin.
    The login state and PKCE verifier still bind the authorization exchange.
    """
    return _validate_origin(value, remote_http=True)


def _validate_origin(value: str, *, remote_http: bool) -> str:
    parsed = urlsplit(value)
    host = parsed.hostname
    if (not value.isascii() or any(char.isspace() for char in value) or "\\" in value
            or not host or parsed.username or parsed.password or parsed.path
            or parsed.query or parsed.fragment or parsed.scheme not in ("https", "http")
            or (parsed.scheme == "http" and not remote_http and not is_private_gateway_hostname(host))):
        raise ValueError("Gateway origin requires HTTPS or private-network HTTP")
    authority = f"[{host}]" if ":" in host else host
    if parsed.port is not None:
        if parsed.port == 0 or parsed.port == (443 if parsed.scheme == "https" else 80):
            raise ValueError("Gateway origin must use a canonical port")
        authority += f":{parsed.port}"
    if value != f"{parsed.scheme}://{authority}":
        raise ValueError("Gateway origin must be canonical")
    return value
