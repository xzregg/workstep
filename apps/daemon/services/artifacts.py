"""Artifact discovery — list files produced for a task, enriched by stage manifests."""

import json
from pathlib import Path
from datetime import datetime, timezone

from services.artifact_rounds import (
    MANIFEST_NAME,
    is_round_child_name,
    iter_artifact_rounds,
)


def _mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()


def list_task_artifacts(project, task_id: str) -> list[dict]:
    """List files produced for a task, enriched by stage manifests."""
    artifacts_root = (Path(project.workstep_dir) / "artifacts").resolve()
    if not artifacts_root.is_dir():
        return []

    artifacts = []
    for workflow_dir in sorted(artifacts_root.iterdir()):
        if not workflow_dir.is_dir():
            continue
        task_dir = (workflow_dir / task_id).resolve()
        try:
            task_dir.relative_to(artifacts_root)
        except ValueError:
            continue
        if not task_dir.is_dir():
            continue

        for step_dir in sorted(task_dir.iterdir()):
            if not step_dir.is_dir():
                continue

            rounds = iter_artifact_rounds(
                artifacts_root,
                workflow_dir.name,
                task_id,
                step_dir.name,
            )
            latest_round = max((item.round for item in rounds), default=0)
            latest_selected_round = max(
                (
                    item.round
                    for item in rounds
                    if item.eligible_for_downstream
                ),
                default=-1,
            )
            for artifact_round in rounds:
                round_dir = artifact_round.path
                manifest_entries: dict[Path, dict] = {}
                manifest = artifact_round.manifest or {}
                for entry in manifest.get("artifacts", []):
                    artifact_path = (round_dir / str(entry.get("path", ""))).resolve()
                    try:
                        artifact_path.relative_to(round_dir.resolve())
                    except ValueError:
                        continue
                    manifest_entries[artifact_path] = entry

                directory_entries: dict[Path, dict] = {}
                for manifest_path_entry, manifest_entry in manifest_entries.items():
                    if manifest_path_entry.is_dir():
                        directory_entries.setdefault(manifest_path_entry, manifest_entry)
                for child in sorted(round_dir.iterdir()):
                    if artifact_round.legacy and is_round_child_name(child.name):
                        continue
                    if child.is_dir() and not child.name.startswith("."):
                        directory_entries.setdefault(child, {})

                for file_path in sorted(round_dir.rglob("*")):
                    relative = file_path.relative_to(round_dir)
                    if (
                        artifact_round.legacy
                        and relative.parts
                        and is_round_child_name(relative.parts[0])
                    ):
                        continue
                    if (
                        not file_path.is_file()
                        or file_path.name == MANIFEST_NAME
                        or any(
                            part.startswith(".")
                            for part in relative.parts
                        )
                    ):
                        continue
                    resolved = file_path.resolve()
                    try:
                        resolved.relative_to(round_dir.resolve())
                    except ValueError:
                        continue
                    metadata = manifest_entries.get(resolved, {})
                    artifacts.append({
                        "step_key": step_dir.name,
                        "round": artifact_round.round,
                        "is_latest": artifact_round.round == latest_round,
                        "is_selected": artifact_round.round == latest_selected_round,
                        "manifest_status": artifact_round.status,
                        "eligible_for_downstream": artifact_round.eligible_for_downstream,
                        "name": file_path.name,
                        "logical_name": metadata.get("name"),
                        "artifact_type": metadata.get("type"),
                        "path": str(resolved),
                        "relative_path": str(file_path.relative_to(round_dir)),
                        "size": resolved.stat().st_size,
                        "is_dir": False,
                        "updated_at": _mtime_iso(resolved),
                    })

                for dir_path, metadata in sorted(
                    directory_entries.items(),
                    key=lambda item: item[0].name.lower(),
                ):
                    artifacts.append({
                        "step_key": step_dir.name,
                        "round": artifact_round.round,
                        "is_latest": artifact_round.round == latest_round,
                        "is_selected": artifact_round.round == latest_selected_round,
                        "manifest_status": artifact_round.status,
                        "eligible_for_downstream": artifact_round.eligible_for_downstream,
                        "name": dir_path.name,
                        "logical_name": metadata.get("name"),
                        "artifact_type": metadata.get("type"),
                        "path": str(dir_path),
                        "relative_path": str(dir_path.relative_to(round_dir)) + "/",
                        "size": None,
                        "is_dir": True,
                        "updated_at": _mtime_iso(dir_path),
                    })
    return artifacts
