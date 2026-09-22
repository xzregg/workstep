#!/usr/bin/env python3
"""Fail CI when public repository essentials drift or leak internal URLs."""

from pathlib import Path
import re
import subprocess
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
    "CHANGELOG.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/pull_request_template.md",
    ".github/workflows/ci.yml",
    ".github/workflows/pages.yml",
    ".github/workflows/desktop-release.yml",
    "plans/README.md",
)
PUBLIC_TEXT = (
    "README.md",
    "README.zh-CN.md",
    "CONTRIBUTING.md",
    "SUPPORT.md",
    "apps/landing/src/config/downloads.ts",
    "apps/landing/src/i18n/en-US.ts",
    "apps/landing/src/i18n/zh-CN.ts",
)
FORBIDDEN = (
    "gitlab.base.packertec.com",
    "your-org",
    "your-username",
    "example/repository.git",
)
PRIVATE_MARKERS = (
    "/Users/" + "x" + "zr/",
    "@" + "qq.com",
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
    if (ROOT / "apps/web/package-lock.json").exists():
        failures.append("apps/web has both package-lock.json and yarn.lock; keep one package manager")
    markdown_files = subprocess.run(
        ["git", "ls-files", "*.md"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    for relative in markdown_files:
        path = ROOT / relative
        text = path.read_text(encoding="utf-8")
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            local = target.strip().split("#", 1)[0]
            if not local or "://" in local or local.startswith(("mailto:", "<")):
                continue
            if not (path.parent / local).resolve().exists():
                failures.append(f"broken local link in {relative}: {target}")
    tracked = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout.split(b"\0")
    for encoded in tracked:
        if not encoded:
            continue
        path = ROOT / encoded.decode("utf-8", errors="surrogateescape")
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        relative = path.relative_to(ROOT)
        for marker in PRIVATE_MARKERS:
            if marker.lower() in text.lower():
                failures.append(f"source {relative} contains private marker: {marker}")
    return failures


if __name__ == "__main__":
    problems = check()
    if problems:
        print("Repository health check failed:", *problems, sep="\n- ")
        raise SystemExit(1)
    print("Repository health check passed")
    raise SystemExit(0)
