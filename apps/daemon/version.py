"""Single runtime version source, overridable by packaged launchers."""

from __future__ import annotations

import json
import os
from pathlib import Path


def _source_version() -> str:
    manifests = (
        Path(__file__).resolve().with_name("app-version.json"),
        Path(__file__).resolve().parents[1] / "desktop" / "package.json",
    )
    for manifest in manifests:
        try:
            value = json.loads(manifest.read_text(encoding="utf-8-sig")).get("version")
            if isinstance(value, str) and value.strip():
                return value.strip().removeprefix("v")
        except (OSError, ValueError):
            continue
    import tomllib
    return tomllib.loads(Path(__file__).with_name("pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]


DEFAULT_VERSION = _source_version()


def normalize_version(value: str | None) -> str:
    normalized = (value or "").strip()
    if normalized.startswith("v"):
        normalized = normalized[1:]
    return normalized or DEFAULT_VERSION


APP_VERSION = normalize_version(os.environ.get("WORKSTEP_VERSION"))
