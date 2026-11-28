"""Storage for shared artifacts declared by steps in a task."""

import json
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:
    from services.pipeline import Step

GLOBAL_DIRECTORY = "Global"
_INDEX = ".workstep-outputs.json"


def global_filename(output: dict) -> str:
    from services.prompt import _artifact_extension

    name = output.get("name")
    if not isinstance(name, str) or not name.strip() or name.startswith(".") or any(
        char in "/\\:`" or ord(char) < 32 for char in name
    ):
        raise ValueError("Global output requires a valid file or directory name")
    kind = output.get("type") or "file"
    return name if str(kind).lower() == "directory" else name + _artifact_extension(kind, name)


def read_global_index(directory: Path) -> dict | None:
    if directory.is_symlink() or directory.parent.is_symlink():
        return None
    marker = directory / _INDEX
    if marker.is_symlink() or not marker.is_file():
        return None
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def global_output_path(directory: Path, filename: str) -> Path | None:
    if not filename or filename.startswith(".") or Path(filename).name != filename:
        return None
    path = directory / filename
    if path.is_symlink() or not path.resolve().is_relative_to(directory.resolve()):
        return None
    return path


def prepare_global_artifacts(
    root: Path, workflow_id: str | None, task_id: str, steps: Iterable["Step"],
) -> list[tuple[str, Path]]:
    """Register declared destinations before any step starts, including disconnected ones."""
    references = []
    root = root.resolve()
    for step in steps:
        outputs = {
            global_filename(output): {"name": output["name"], "type": output.get("type") or "file", "port": port}
            for port, output in enumerate(step.outputs) if isinstance(output, dict) and output.get("global") is True
        }
        if not outputs:
            continue
        directory = root / (workflow_id or "default") / task_id / step.key / GLOBAL_DIRECTORY
        if directory != directory.resolve() or not directory.is_relative_to(root):
            raise ValueError(f"Invalid Global directory for step {step.key}")
        index = read_global_index(directory)
        if directory.exists() and index is None:
            raise ValueError(f"Global directory already exists for step {step.key}")
        for name, output in outputs.items():
            path = global_output_path(directory, name)
            if path is None:
                raise ValueError(f"Invalid Global output for step {step.key}: {name}")
            references.append((output["name"], path))
        updated = {**(index or {}), **outputs}
        if index != updated:
            directory.mkdir(exist_ok=True, parents=True)
            with tempfile.NamedTemporaryFile(mode="w", dir=directory, prefix=".outputs-", encoding="utf-8", delete=False) as stream:
                temporary = Path(stream.name)
                try:
                    json.dump(updated, stream, ensure_ascii=False)
                    stream.close()
                    temporary.replace(directory / _INDEX)
                finally:
                    temporary.unlink(missing_ok=True)
    return references
