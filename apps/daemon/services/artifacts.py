"""Artifact discovery — list files produced for a task, enriched by step manifests."""

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


def _manifest_validation(
    manifest: dict | None,
    actual_files: dict[str, tuple[int, float]],
    actual_dirs: set[str],
    symlinks: set[str],
) -> set[str] | None:
    """Validate observed metadata; never read artifact bytes in a listing."""
    if not isinstance(manifest, dict) or not isinstance(manifest.get("directory_paths"), list):
        return None
    try:
        generated_at = datetime.fromisoformat(manifest["generated_at"]).timestamp()
        expected_dirs = set(manifest["directory_paths"])
        expected_files = {
            entry["path"]: entry
            for entry in manifest["artifacts"]
            if isinstance(entry, dict) and isinstance(entry.get("sha256"), str)
        }
        invalid = set(symlinks)
        for relative, (size, modified_at) in actual_files.items():
            entry = expected_files.get(relative)
            if entry is None or entry.get("size") != size or modified_at > generated_at:
                invalid.add(relative)
        return invalid | (set(actual_files) ^ set(expected_files)) | (actual_dirs ^ expected_dirs)
    except (KeyError, TypeError, ValueError):
        return None


def _path_still_valid(path: str, invalid: set[str] | None) -> bool:
    if invalid is None:
        return False
    path = path.rstrip("/")
    return not any(item == path or item.startswith(path + "/") for item in invalid)


def list_task_artifacts(project, task_id: str) -> list[dict]:
    """List files produced for a task, enriched by step manifests."""
    artifacts_root = (Path(project.workstep_dir) / "artifacts").resolve()
    if not artifacts_root.is_dir():
        return []

    artifacts = []
    for workflow_dir in sorted(artifacts_root.iterdir()):
        if workflow_dir.name == "actions" or not workflow_dir.is_dir():
            continue
        task_dir = (workflow_dir / task_id).resolve()
        try:
            task_dir.relative_to(artifacts_root)
        except ValueError:
            continue
        if not task_dir.is_dir():
            continue

        for step_dir in sorted(task_dir.iterdir()):
            if step_dir.name.startswith(".") or not step_dir.is_dir():
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
            previous_invalid = None
            previous_round = None
            for artifact_round in rounds:
                round_dir = artifact_round.path
                round_start = len(artifacts)
                observed_files: dict[str, tuple[int, float]] = {}
                observed_dirs: set[str] = set()
                observed_symlinks: set[str] = set()
                manifest_entries: dict[Path, dict] = {}
                manifest = artifact_round.manifest or {}
                for entry in manifest.get("artifacts", []):
                    artifact_path = (round_dir / str(entry.get("path", ""))).resolve()
                    try:
                        artifact_path.relative_to(round_dir.resolve())
                    except ValueError:
                        continue
                    manifest_entries[artifact_path] = entry

                output_ports: dict[Path, int] = {}
                for output in manifest.get("outputs", []):
                    if not isinstance(output, dict) or not isinstance(output.get("port"), int):
                        continue
                    output_path = (round_dir / str(output.get("path", ""))).resolve()
                    if output_path.is_relative_to(round_dir.resolve()):
                        output_ports[output_path] = output["port"]

                directory_entries: dict[Path, dict] = {}
                for manifest_path_entry, manifest_entry in manifest_entries.items():
                    if manifest_path_entry.is_dir():
                        directory_entries.setdefault(manifest_path_entry, manifest_entry)
                for child in sorted(round_dir.iterdir()):
                    if artifact_round.legacy and is_round_child_name(child.name):
                        continue
                    if child.is_dir() and not child.name.startswith("."):
                        directory_entries.setdefault(child, {})
                directory_roots = tuple(
                    path.resolve() for path in directory_entries
                )

                for file_path in sorted(round_dir.rglob("*")):
                    relative = file_path.relative_to(round_dir)
                    if file_path.name == MANIFEST_NAME:
                        continue
                    if (
                        artifact_round.legacy
                        and relative.parts
                        and is_round_child_name(relative.parts[0])
                    ):
                        continue
                    relative_name = relative.as_posix()
                    if file_path.is_symlink():
                        observed_symlinks.add(relative_name)
                    elif file_path.is_dir():
                        observed_dirs.add(relative_name)
                    elif file_path.is_file():
                        file_stat = file_path.stat()
                        observed_files[relative_name] = (file_stat.st_size, file_stat.st_mtime)
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
                    if any(
                        resolved.is_relative_to(directory_root)
                        for directory_root in directory_roots
                    ):
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
                        "output_port": output_ports.get(resolved),
                        "declared_output": resolved in manifest_entries,
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
                        "output_port": output_ports.get(dir_path.resolve()),
                        "declared_output": dir_path.resolve() in manifest_entries,
                        "path": str(dir_path),
                        "relative_path": str(dir_path.relative_to(round_dir)) + "/",
                        "size": None,
                        "is_dir": True,
                        "updated_at": _mtime_iso(dir_path),
                    })
                invalid = _manifest_validation(
                    manifest, observed_files, observed_dirs, observed_symlinks,
                )
                comparison = manifest.get("content_comparison")
                if not isinstance(comparison, dict) or comparison.get("previous_round") != previous_round:
                    comparison = None
                round_unchanged_from = (
                    previous_round
                    if comparison is not None and comparison.get("round_unchanged") is True
                    and invalid == set() and previous_invalid == set() else None
                )
                unchanged_paths = set(comparison.get("unchanged_paths", [])) if comparison else set()
                for artifact in artifacts[round_start:]:
                    artifact["round_unchanged_from"] = round_unchanged_from
                    artifact["unchanged_from_round"] = (
                        previous_round
                        if artifact["relative_path"].rstrip("/") in unchanged_paths
                        and _path_still_valid(artifact["relative_path"], invalid)
                        and _path_still_valid(artifact["relative_path"], previous_invalid)
                        else None
                    )
                previous_invalid = invalid
                previous_round = artifact_round.round
    return artifacts


def list_task_artifact_input_snapshots(task_id: str) -> list[dict]:
    """Return the exact upstream artifacts consumed by each produced round."""
    from models import StepRun, WorkflowRun

    rows = (
        StepRun.select(StepRun, WorkflowRun)
        .join(WorkflowRun)
        .where(
            (WorkflowRun.task == task_id)
            & StepRun.artifact_round.is_null(False)
            & StepRun.input_snapshot_json.is_null(False)
        )
        .order_by(StepRun.started_at, StepRun.id)
    )
    snapshots: dict[tuple[str, int], dict] = {}
    for row in rows:
        try:
            snapshot = json.loads(row.input_snapshot_json or "")
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(snapshot, dict):
            continue
        key = (row.step_key, int(row.artifact_round))
        snapshots[key] = {
            "step_key": row.step_key,
            "round": int(row.artifact_round),
            **snapshot,
        }
    return [snapshots[key] for key in sorted(snapshots)]


def project_relative_artifact_listing(
    project, artifacts: list[dict], input_snapshots: list[dict],
) -> tuple[list[dict], list[dict]]:
    """Project a task's artifact paths without exposing host filesystem paths."""
    project_root = project.path.resolve()

    def relative_path(value: str) -> str | None:
        path = Path(value)
        try:
            return (path if path.is_absolute() else project_root / path).resolve().relative_to(
                project_root
            ).as_posix()
        except ValueError:
            try:
                return (Path(".workstep") / path.resolve().relative_to(project.workstep_dir.resolve())).as_posix()
            except ValueError:
                return None

    visible_artifacts = []
    for artifact in artifacts:
        path = relative_path(artifact["path"])
        if path is not None:
            visible_artifacts.append({**artifact, "path": path})

    visible_snapshots = []
    for snapshot in input_snapshots:
        ports = []
        for port in snapshot.get("ports", []):
            sources = []
            for source in port.get("sources", []):
                if not isinstance(source, dict) or not isinstance(source.get("path"), str):
                    continue
                path = relative_path(source["path"])
                if path is not None:
                    sources.append({**source, "path": path})
            ports.append({**port, "sources": sources})
        visible_snapshots.append({**snapshot, "ports": ports})
    return visible_artifacts, visible_snapshots
