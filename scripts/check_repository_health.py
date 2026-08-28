#!/usr/bin/env python3
"""Fail CI when public repository essentials drift or leak internal URLs."""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    "README.md",
    "README.zh-CN.md",
    "LICENSE",
    "NOTICE",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "SUPPORT.md",
    "CODE_OF_CONDUCT.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/pull_request_template.md",
    ".github/workflows/ci.yml",
    ".github/workflows/pages.yml",
    ".github/workflows/desktop-release.yml",
)
PUBLIC_TEXT = (
    "README.md",
    "README.zh-CN.md",
    "CONTRIBUTING.md",
    "SUPPORT.md",
    "apps/landing/src/config/downloads.ts",
)
FORBIDDEN = (
    "gitlab.base.packertec.com",
    "your-org",
    "your-username",
    "example/repository.git",
)


def check() -> list[str]:
    failures: list[str] = []
    for relative in REQUIRED:
        if not (ROOT / relative).is_file():
            failures.append(f"missing required file: {relative}")
    for relative in PUBLIC_TEXT:
        path = ROOT / relative
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8").lower()
        for marker in FORBIDDEN:
            if marker in text:
                failures.append(f"public file {relative} contains forbidden marker: {marker}")
    for readme, peer in (("README.md", "README.zh-CN.md"), ("README.zh-CN.md", "README.md")):
        if peer not in (ROOT / readme).read_text(encoding="utf-8"):
            failures.append(f"{readme} does not link to {peer}")
    return failures


if __name__ == "__main__":
    problems = check()
    if problems:
        print("Repository health check failed:", *problems, sep="\n- ")
        raise SystemExit(1)
    print("Repository health check passed")
    raise SystemExit(0)
