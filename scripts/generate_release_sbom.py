#!/usr/bin/env python3
"""Generate a compact CycloneDX inventory for the desktop release payload."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


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
        "purl": f"pkg:{ecosystem}/{package_name}@{normalized}",
    }


def _python_components() -> list[dict[str, str]]:
    components = []
    backend = ROOT / "apps" / "desktop" / "backend"
    for filename in ("requirements-prod.txt", "requirements-bootstrap.txt"):
        for line in (backend / filename).read_text(encoding="utf-8").splitlines():
            match = re.match(r"^([A-Za-z0-9_.-]+)==([^ ;]+)", line)
            if match:
                components.append(_component("pypi", match.group(1), match.group(2)))
    return components


def _javascript_components() -> list[dict[str, str]]:
    components = []
    for relative in ("apps/desktop/package.json", "apps/web/package.json"):
        package = json.loads((ROOT / relative).read_text(encoding="utf-8"))
        dependencies = dict(package.get("dependencies", {}))
        if relative == "apps/desktop/package.json":
            electron = package.get("devDependencies", {}).get("electron")
            if electron:
                dependencies["electron"] = electron
        for name, version in dependencies.items():
            components.append(_component("npm", name, str(version)))
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
