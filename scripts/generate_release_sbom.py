#!/usr/bin/env python3
"""Generate a compact CycloneDX inventory for the desktop release payload."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]


def _normalize_version(value: str) -> str:
    return value.lstrip("~^<>= ") or value


def _component(ecosystem: str, name: str, version: str) -> dict[str, str]:
    normalized = _normalize_version(version)
    package_name = name.lower().replace("_", "-") if ecosystem == "pypi" else name
    return {
        "type": "library",
        "name": name,
        "version": normalized,
        "purl": f"pkg:{ecosystem}/{quote(package_name, safe='/')}@{normalized}",
    }


def _python_components() -> list[dict[str, str]]:
    components = []
    backend = ROOT / "apps" / "desktop" / "backend"
    for filename in ("requirements-prod.txt", "requirements-gateway.txt", "requirements-bootstrap.txt"):
        for line in (backend / filename).read_text(encoding="utf-8").splitlines():
            match = re.match(r"^([A-Za-z0-9_.-]+)==([^ ;]+)", line)
            if match:
                components.append(_component("pypi", match.group(1), match.group(2)))
    return components


def _selector_name(selector: str) -> str:
    value = selector.strip().strip('"')
    return value.rsplit("@", 1)[0]


def _yarn_lock_components(path: Path) -> list[dict[str, str]]:
    """Read exact direct and transitive versions from a Yarn v1 lockfile."""
    components: list[dict[str, str]] = []
    names: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith((" ", "#")) and line.endswith(":"):
            names = [_selector_name(item) for item in line[:-1].split(",")]
            continue
        match = re.match(r'^  version "([^"]+)"$', line)
        if match and names:
            components.extend(
                _component("npm", name, match.group(1)) for name in set(names)
            )
    return components


def _javascript_components() -> list[dict[str, str]]:
    components: list[dict[str, str]] = []
    for relative in ("apps/desktop/yarn.lock", "apps/web/yarn.lock"):
        components.extend(_yarn_lock_components(ROOT / relative))
    return components


def build_bom(version: str) -> dict:
    unique = {
        item["purl"]: item
        for item in (*_python_components(), *_javascript_components())
    }
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "name": "WorkStep",
                "version": version,
                "licenses": [{"license": {"id": "Apache-2.0"}}],
            }
        },
        "components": sorted(unique.values(), key=lambda item: (item["purl"], item["name"])),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(build_bom(args.version), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
