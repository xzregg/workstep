#!/usr/bin/env python3
"""Scan tracked content and reachable Git history for high-confidence secrets."""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "AWS access key": r"(AKIA|ASIA)[0-9A-Z]{16}",
    "GitHub token": r"(gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})",
    "OpenAI key": r"(sk-(proj|svcacct)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{48})",
    "Anthropic key": r"sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}",
    "Google API key": r"AIza[0-9A-Za-z_-]{30,}",
    "Slack token": r"xox[baprs]-[0-9A-Za-z-]{20,}",
    "private key": r"-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
}
COMBINED = "(" + "|".join(PATTERNS.values()) + ")"
# Reviewed 2026-10-16: the SecOps role lists two bare PEM opening markers
# as detection examples, with no key body or closing marker. Pin the entire
# content, not a directory/pattern: any edit must be reviewed again.
REVIEWED_DOCUMENTATION = {
    'apps/daemon/data/role-center/roles/agency-367eccc119495783b1e97dc108c4b3ea.json':
        '6b670257b64f8746208e74c5b09621e169ea57c133033946f14e72181e8be7fd',
}


def matching_kinds(text: str) -> list[str]:
    return [name for name, pattern in PATTERNS.items() if re.search(pattern, text)]


def unreviewed_kinds(path: str, content: str) -> list[str]:
    kinds = matching_kinds(content)
    if (kinds == ['private key'] and REVIEWED_DOCUMENTATION.get(path)
            == hashlib.sha256(content.encode('utf-8')).hexdigest()):
        return []
    return kinds


def _run(*args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        args,
        cwd=ROOT,
        check=check,
        capture_output=True,
    )


def scan() -> list[str]:
    findings: set[str] = set()
    worktree_files = _run(
        "git",
        "ls-files",
        "-co",
        "--exclude-standard",
        "-z",
    ).stdout.split(b"\0")
    for encoded in worktree_files:
        if not encoded:
            continue
        relative = encoded.decode("utf-8", errors="surrogateescape")
        try:
            content = (ROOT / relative).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if unreviewed_kinds(relative, content):
            findings.add(f"worktree:{relative}")

    commits = _run("git", "rev-list", "--all").stdout.decode().splitlines()
    for target in commits:
        args = ["git", "grep", "-I", "-l", "-E", COMBINED, target, "--"]
        result = _run(*args, check=False)
        if result.returncode not in (0, 1):
            raise RuntimeError(result.stderr.decode(errors="replace"))
        for raw in result.stdout.decode(errors="replace").splitlines():
            path = raw.split(":", 1)[-1]
            if path in REVIEWED_DOCUMENTATION:
                content = _run('git', 'show', f'{target}:{path}').stdout.decode('utf-8')
                if not unreviewed_kinds(path, content):
                    continue
            findings.add(f"{target[:12]}:{path}")
    return sorted(findings)


if __name__ == "__main__":
    matches = scan()
    if matches:
        print("High-confidence secret candidates found (values suppressed):")
        print(*matches, sep="\n- ")
        raise SystemExit(1)
    print("Secret scan passed")
    raise SystemExit(0)
