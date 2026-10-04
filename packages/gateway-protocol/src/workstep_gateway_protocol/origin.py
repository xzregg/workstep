"""Canonical HTTPS origins, with HTTP permitted only on loopback hosts."""

from ipaddress import ip_address
from urllib.parse import urlsplit


def is_loopback_hostname(host: str) -> bool:
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def validate_gateway_origin(value: str) -> str:
    parsed = urlsplit(value)
    host = parsed.hostname
    if (not value.isascii() or any(char.isspace() for char in value) or "\\" in value
            or not host or parsed.username or parsed.password or parsed.path
            or parsed.query or parsed.fragment or parsed.scheme not in ("https", "http")
            or (parsed.scheme == "http" and not is_loopback_hostname(host))):
        raise ValueError("Gateway origin requires HTTPS or loopback HTTP")
    authority = f"[{host}]" if ":" in host else host
    if parsed.port is not None:
        if parsed.port == 0 or parsed.port == (443 if parsed.scheme == "https" else 80):
            raise ValueError("Gateway origin must use a canonical port")
        authority += f":{parsed.port}"
    if value != f"{parsed.scheme}://{authority}":
        raise ValueError("Gateway origin must be canonical")
    return value
