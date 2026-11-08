#!/usr/bin/env python3
"""Copy or validate first-party release files; never scan the user's HOME."""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
from pathlib import Path
import shutil
import sys

from check_secrets import REVIEWED_DOCUMENTATION, unreviewed_kinds


EXCLUDED_DIRS = {
    '.git', '.workstep', '.agents', '.claude', '.idea', '.vscode', '.venv',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache',
    'node_modules', 'plans', 'tests', 'test-results', 'playwright-report',
    'tmp', 'temp', 'logs', '.pids', 'audit-context', '.ssh', '.aws', '.azure',
    '.gnupg', '.secrets', '.kube',
}
EXCLUDED_FILES = (
    '.env*', '*.env', '*.env.*', '.DS_Store', '*.pyc', '*.pyo', '*.log', '*.tmp', '*.temp', '*.bak',
    '*.swp', '*~', '*.map', '*.db', '*.db-*', '*.sqlite*', '*.pem', '*.key',
    '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '*.local.json', '.npmrc',
    '.pypirc', '.netrc', 'credentials*', 'secrets.*', 'service-account*.json',
    '*.jks', '*.keystore', '*.p8',
)


def excluded(relative: Path, root: Path) -> bool:
    # This runtime module handles credentials; it is not a credential file.
    # inventory() still checks its contents for secrets and rejects symlinks.
    if (relative.as_posix() == 'services/git/credentials.py'
            or root.name == 'services' and relative.as_posix() == 'git/credentials.py'):
        return False
    return any(part.casefold() in EXCLUDED_DIRS for part in relative.parts) or any(
        fnmatch.fnmatchcase(relative.name.casefold(), pattern.casefold()) for pattern in EXCLUDED_FILES
    )


def inventory(root: Path, *, copying: bool, ignore_runtime_venv: bool = False) -> list[Path]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Payload root must be a real directory')
    files = []

    def visit(directory: Path):
        for file in sorted(directory.iterdir()):
            relative = file.relative_to(root)
            if ignore_runtime_venv and relative == Path('.venv') and file.is_dir() and not file.is_symlink():
                continue  # Docker's locked installed runtime, not first-party source.
            if excluded(relative, root):
                if copying:
                    continue
                raise ValueError(f'Forbidden release path: {relative.as_posix()}')
            if file.is_symlink():
                raise ValueError(f'Symlink not allowed in first-party payload: {relative.as_posix()}')
            if file.is_dir():
                visit(file)
            elif file.is_file():
                data = file.read_bytes()
                # Match ASCII key signatures in binary as well as text assets.
                text = data.decode('utf-8', errors='replace')
                kinds = unreviewed_kinds('', text)
                reviewed = (kinds == ['private key'] and
                            hashlib.sha256(data).hexdigest() in REVIEWED_DOCUMENTATION.values())
                if kinds and not reviewed:
                    raise ValueError(f'Secret candidate in release file: {relative.as_posix()} (value suppressed)')
                files.append(relative)
            else:
                raise ValueError(f'Special file not allowed: {relative.as_posix()}')

    visit(root)
    return files


def copy_payload(source: Path, destination: Path):
    # Refuse overwrites and validate the entire source before copying any bytes.
    if destination.exists() or destination.is_symlink():
        raise ValueError('Payload destination must not exist')
    files = inventory(source, copying=True)
    destination.mkdir(parents=True)
    for relative in files:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, target, follow_symlinks=False)
    inventory(destination, copying=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('copy', 'check'))
    parser.add_argument('paths', nargs='+', type=Path)
    parser.add_argument('--ignore-runtime-venv', action='store_true')
    args = parser.parse_args()
    try:
        if args.action == 'copy':
            if len(args.paths) != 2 or args.ignore_runtime_venv:
                parser.error('copy requires source and new destination')
            copy_payload(*args.paths)
        else:
            for root in args.paths:
                inventory(root, copying=False, ignore_runtime_venv=args.ignore_runtime_venv)
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print('Release payload check passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
