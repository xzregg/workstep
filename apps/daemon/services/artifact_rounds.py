"""Artifact round directory helpers.

Artifacts live under::

    .workstep/artifacts/<workflow>/<task>/<step>/<round>/

Legacy databases wrote artifacts directly under ``<step>/``.  Those files are
treated as round 1 for read compatibility, without moving them on disk.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

ROUND_DIR_RE = re.compile(r"^[1-9][0-9]*$")
MANIFEST_NAME = "manifest.json"


@dataclass(frozen=True, slots=True)
class ArtifactRound:
    """One readable artifact round directory."""

    round: int
    path: Path
    legacy: bool = False
    manifest: dict | None = None

    @property
    def eligible_for_downstream(self) -> bool:
        if self.legacy and (
            self.manifest is None
            or "eligible_for_downstream" not in self.manifest
        ):
            return True
        if not isinstance(self.manifest, dict):
            return False
        return bool(self.manifest.get("eligible_for_downstream", False))

    @property
    def status(self) -> str | None:
        if not isinstance(self.manifest, dict):
            return None
        value = self.manifest.get("status")
        return str(value) if value is not None else None


def workflow_step_dir(
    artifacts_root: Path,
    workflow_id: str | None,
    task_id: str,
    step_key: str,
) -> Path:
    """Return the stage directory containing round subdirectories."""
    return Path(artifacts_root) / (workflow_id or "default") / task_id / step_key


def step_round_dir(
    artifacts_root: Path,
    workflow_id: str | None,
    task_id: str,
    step_key: str,
    artifact_round: int,
) -> Path:
    """Return one concrete artifact round directory."""
    if int(artifact_round) < 1:
        raise ValueError("artifact_round must be >= 1")
    return workflow_step_dir(artifacts_root, workflow_id, task_id, step_key) / str(
        int(artifact_round)
    )


def manifest_path(round_dir: Path) -> Path:
    return Path(round_dir) / MANIFEST_NAME


def _read_manifest(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _legacy_has_artifacts(step_dir: Path) -> bool:
    if not step_dir.is_dir():
        return False
    for child in step_dir.iterdir():
        if child.name.startswith("."):
            continue
        if child.name == MANIFEST_NAME and child.is_file():
            return True
        if child.is_dir() and not ROUND_DIR_RE.match(child.name):
            return True
        if child.is_file():
            return True
    return False


def iter_artifact_rounds(
    artifacts_root: Path,
    workflow_id: str | None,
    task_id: str,
    step_key: str,
) -> list[ArtifactRound]:
    """Return readable rounds for one stage in ascending round order."""
    step_dir = workflow_step_dir(artifacts_root, workflow_id, task_id, step_key)
    rounds: list[ArtifactRound] = []
    if not step_dir.is_dir():
        return rounds

    if _legacy_has_artifacts(step_dir):
        rounds.append(
            ArtifactRound(
                round=1,
                path=step_dir,
                legacy=True,
                manifest=_read_manifest(step_dir / MANIFEST_NAME),
            )
        )

    for child in step_dir.iterdir():
        if not child.is_dir() or not ROUND_DIR_RE.match(child.name):
            continue
        round_number = int(child.name)
        if any(item.round == round_number for item in rounds):
            continue
        rounds.append(
            ArtifactRound(
                round=round_number,
                path=child,
                manifest=_read_manifest(child / MANIFEST_NAME),
            )
        )
    return sorted(rounds, key=lambda item: item.round)


def max_existing_round(
    artifacts_root: Path,
    workflow_id: str | None,
    task_id: str,
    step_key: str,
) -> int:
    rounds = iter_artifact_rounds(artifacts_root, workflow_id, task_id, step_key)
    return max((item.round for item in rounds), default=0)


def next_artifact_round(
    artifacts_root: Path,
    workflow_id: str | None,
    task_id: str,
    step_key: str,
    *,
    database_round: int | None = None,
) -> int:
    """Return the next round after both filesystem and database history."""
    return max(
        max_existing_round(artifacts_root, workflow_id, task_id, step_key),
        int(database_round or 0),
    ) + 1


def discard_artifact_round(
    artifacts_root: Path,
    workflow_id: str | None,
    task_id: str,
    step_key: str,
    artifact_round: int,
) -> None:
    """Remove an uncommitted round directory after an execution attempt fails."""
    round_dir = step_round_dir(
        artifacts_root,
        workflow_id,
        task_id,
        step_key,
        artifact_round,
    )
    if not round_dir.is_dir():
        return
    manifest = _read_manifest(manifest_path(round_dir))
    if isinstance(manifest, dict) and manifest.get("eligible_for_downstream"):
        return
    shutil.rmtree(round_dir)


def select_upstream_round(
    artifacts_root: Path,
    workflow_id: str | None,
    task_id: str,
    step_key: str,
    requested_round: int | None = None,
) -> ArtifactRound | None:
    """Resolve the explicit round or latest downstream-eligible round."""
    rounds = iter_artifact_rounds(artifacts_root, workflow_id, task_id, step_key)
    if requested_round is not None:
        requested = int(requested_round)
        return next((item for item in rounds if item.round == requested), None)
    eligible = [item for item in rounds if item.eligible_for_downstream]
    return max(eligible, key=lambda item: item.round, default=None)


def list_round_files(round_dir: Path) -> list[Path]:
    """List files under one round, excluding the system manifest."""
    root = Path(round_dir).resolve()
    if not root.is_dir():
        return []
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name == MANIFEST_NAME:
            continue
        if path.is_symlink():
            continue
        resolved = path.resolve()
        try:
            resolved.relative_to(root)
        except ValueError:
            continue
        files.append(resolved)
    return files


def is_round_child_name(name: str) -> bool:
    return bool(ROUND_DIR_RE.match(name))


def _declared_entries(round_dir: Path, outputs: Iterable[dict] | None) -> dict[Path, dict]:
    if not outputs:
        return {}
    from services.prompt import _output_path

    result: dict[Path, dict] = {}
    for index, output in enumerate(outputs, 1):
        name = str(output.get("name") or f"产物{index}")
        output_type = str(output.get("type") or "file")
        _label, value = _output_path(str(round_dir), name, output_type)
        path = Path(value).resolve()
        try:
            path.relative_to(round_dir.resolve())
        except ValueError:
            continue
        result[path] = {
            "name": name,
            "type": output_type,
        }
    return result


def build_manifest_entry(path: Path, round_dir: Path, metadata: dict | None = None) -> dict:
    resolved = path.resolve()
    relative = resolved.relative_to(Path(round_dir).resolve())
    entry = {
        "name": (metadata or {}).get("name") or path.name,
        "type": (metadata or {}).get("type") or ("Directory" if path.is_dir() else path.suffix.lstrip(".")),
        "path": str(relative),
    }
    if path.is_file():
        entry["size"] = resolved.stat().st_size
        entry["sha256"] = hashlib.sha256(resolved.read_bytes()).hexdigest()
    return entry


def write_round_manifest(
    *,
    artifacts_root: Path,
    workflow_id: str | None,
    task_id: str,
    step_key: str,
    artifact_round: int,
    workflow_run_id: str | None = None,
    step_run_id: str | None = None,
    input_rounds: dict[str, int] | None = None,
    status: str,
    eligible_for_downstream: bool,
    outputs: Iterable[dict] | None = None,
) -> dict:
    """Scan one round directory and atomically write its system manifest."""
    round_dir = step_round_dir(
        artifacts_root,
        workflow_id,
        task_id,
        step_key,
        artifact_round,
    )
    round_dir.mkdir(parents=True, exist_ok=True)
    previous_round = max(
        (
            item.round
            for item in iter_artifact_rounds(
                artifacts_root,
                workflow_id,
                task_id,
                step_key,
            )
            if item.round < int(artifact_round)
        ),
        default=None,
    )
    declared = _declared_entries(round_dir, outputs)

    entries: dict[Path, dict] = {}
    for file_path in list_round_files(round_dir):
        entries[file_path] = build_manifest_entry(
            file_path,
            round_dir,
            declared.get(file_path),
        )
    for directory, metadata in declared.items():
        if directory.is_dir():
            entries[directory] = build_manifest_entry(directory, round_dir, metadata)

    manifest = {
        "version": 1,
        "workflow": workflow_id or "default",
        "task_id": task_id,
        "step_key": step_key,
        "round": int(artifact_round),
        "previous_round": previous_round,
        "workflow_run_id": workflow_run_id,
        "step_run_id": step_run_id,
        "input_rounds": input_rounds or {},
        "status": status,
        "eligible_for_downstream": bool(eligible_for_downstream),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "artifacts": sorted(entries.values(), key=lambda item: str(item["path"])),
    }
    path = manifest_path(round_dir)
    fd, temp_name = tempfile.mkstemp(prefix=".manifest-", dir=round_dir)
    try:
        with open(fd, "w", encoding="utf-8") as stream:
            json.dump(manifest, stream, ensure_ascii=False, indent=2)
        Path(temp_name).replace(path)
    finally:
        temp_path = Path(temp_name)
        if temp_path.exists():
            temp_path.unlink()
    return manifest


def update_round_manifest_status(
    *,
    artifacts_root: Path,
    workflow_id: str | None,
    task_id: str,
    step_key: str,
    artifact_round: int,
    status: str,
    eligible_for_downstream: bool,
) -> dict | None:
    """Update status fields on an existing round manifest."""
    round_dir = step_round_dir(
        artifacts_root,
        workflow_id,
        task_id,
        step_key,
        artifact_round,
    )
    path = manifest_path(round_dir)
    manifest = _read_manifest(path)
    if manifest is None:
        return None
    manifest["status"] = status
    manifest["eligible_for_downstream"] = bool(eligible_for_downstream)
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
    fd, temp_name = tempfile.mkstemp(prefix=".manifest-", dir=round_dir)
    try:
        with open(fd, "w", encoding="utf-8") as stream:
            json.dump(manifest, stream, ensure_ascii=False, indent=2)
        Path(temp_name).replace(path)
    finally:
        temp_path = Path(temp_name)
        if temp_path.exists():
            temp_path.unlink()
    return manifest


def artifact_id_for(
    workflow_id: str | None,
    step_key: str,
    artifact_round: int,
    relative_path: str,
) -> str:
    digest = hashlib.sha256(
        f"{workflow_id or 'default'}/{step_key}/{int(artifact_round)}/{relative_path}".encode()
    ).hexdigest()[:20]
    return f"artifact-{digest}"
