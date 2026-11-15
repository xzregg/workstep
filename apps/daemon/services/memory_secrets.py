"""Sanitize display/persistence copies, never actual engine/tool input."""
import re
from collections.abc import Mapping

_TOKEN = re.compile(r'wsm_[A-Za-z0-9_-]{43}')
REDACTED = '[REDACTED_MEMORY_TOKEN]'


def redact(value):
    """Prefix recognition also protects expired tokens and post-restart replay."""
    if isinstance(value,str):
        return _TOKEN.sub(REDACTED,value)
    if isinstance(value,Mapping):
        return {redact(key):redact(item) for key,item in value.items()}
    if isinstance(value,list):
        return [redact(item) for item in value]
    if isinstance(value,tuple):
        return tuple(redact(item) for item in value)
    return value
