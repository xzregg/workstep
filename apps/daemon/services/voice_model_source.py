"""Hugging Face-compatible endpoints for host-managed model downloads."""
from urllib.parse import urlsplit

HUGGING_FACE = 'https://huggingface.co'


def model_origin(mirror: str | None) -> str:
    if mirror is None:
        return HUGGING_FACE
    origin = mirror.strip().rstrip('/')
    try:
        url = urlsplit(origin)
        port = url.port
        if (url.scheme in ('https', 'http') and url.hostname and port != 0
                and not (url.username is not None or url.password is not None)
                and not any(char.isspace() or ord(char) < 32 or char in '\\?#' for char in origin)):
            return origin
    except ValueError:
        pass
    raise ValueError('Please enter a valid HTTP(S) model image address')
