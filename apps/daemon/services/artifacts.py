"""Artifact discovery — list files produced for a task, enriched by stage manifests."""

import json
from pathlib import Path


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

            manifest_entries: dict[Path, dict] = {}
            manifest_path = step_dir / "manifest.json"
            if manifest_path.is_file():
                try:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    for entry in manifest.get("artifacts", []):
                        artifact_path = (step_dir / str(entry.get("path", ""))).resolve()
                        try:
                            artifact_path.relative_to(step_dir)
                        except ValueError:
                            continue
                        manifest_entries[artifact_path] = entry
                except (OSError, ValueError, TypeError):
                    pass

            directory_entries: dict[Path, dict] = {}
            for manifest_path_entry, manifest_entry in manifest_entries.items():
                if manifest_path_entry.is_dir():
                    directory_entries.setdefault(manifest_path_entry, manifest_entry)
            for child in sorted(step_dir.iterdir()):
                if child.is_dir() and not child.name.startswith("."):
                    directory_entries.setdefault(child, {})

            for file_path in sorted(step_dir.rglob("*")):
                if not file_path.is_file() or file_path.name == "manifest.json":
                    continue
                resolved = file_path.resolve()
                try:
                    resolved.relative_to(step_dir)
                except ValueError:
                    continue
                metadata = manifest_entries.get(resolved, {})
                artifacts.append({
                    "step_key": step_dir.name,
                    "name": file_path.name,
                    "logical_name": metadata.get("name"),
                    "artifact_type": metadata.get("type"),
                    "path": str(resolved),
                    "relative_path": str(resolved.relative_to(step_dir)),
                    "size": resolved.stat().st_size,
                    "is_dir": False,
                })

            for dir_path, metadata in sorted(
                directory_entries.items(),
                key=lambda item: item[0].name.lower(),
            ):
                artifacts.append({
                    "step_key": step_dir.name,
                    "name": dir_path.name,
                    "logical_name": metadata.get("name"),
                    "artifact_type": metadata.get("type"),
                    "path": str(dir_path),
                    "relative_path": str(dir_path.relative_to(step_dir)) + "/",
                    "size": None,
                    "is_dir": True,
                })
    return artifacts
