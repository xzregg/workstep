"""Single runtime version source, overridable by packaged launchers."""

from __future__ import annotations

import os


DEFAULT_VERSION = "0.1.0"


def normalize_version(value: str | None) -> str:
    normalized = (value or "").strip()
    if normalized.startswith("v"):
        normalized = normalized[1:]
    return normalized or DEFAULT_VERSION


APP_VERSION = normalize_version(os.environ.get("WORKSTEP_VERSION"))
