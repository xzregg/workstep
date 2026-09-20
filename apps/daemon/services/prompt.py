"""Prompt assembly — builds the full prompt for each pipeline step."""

import json
from pathlib import Path

from models import StageSupplement
from models.task import Task
from services.artifact_rounds import select_upstream_round, step_round_dir
from services.pipeline import Step

# Config path relative to this file
_OUTPUT_TYPES_PATH = Path(__file__).resolve().parent.parent / "data" / "output-types.json"
_DEFAULT_CONSTRAINT = "Generic UTF-8 text; clear structure and directly readable."
_OUTPUT_GUIDANCE = "Decide from the stage requirements and available context whether outputs are ready. If information is insufficient, you may omit artifacts or leave them empty; do not invent filler or placeholders just to satisfy the output list. Explain the reason in your reply. Generated artifacts must keep their declared names, types, and paths."

# System prompt injected at the start of every step
SYSTEM_PROMPT = """You are executing one stage in a WorkStep workflow.
Work in the current project root and produce outputs only when the stage has enough information.
Write artifacts under .workstep/artifacts/<workflow>/<task>/<stage>/<round>/.
For a directory output, create a directory named <artifact>/. For a file output, write the file directly as <artifact>.<extension>.
Follow the declared output names, types, and paths; an empty artifact is allowed when appropriate."""


def _load_project_memory(artifacts_dir: Path, limit: int = 50_000) -> str | None:
    """Read the project's .workstep/MEMORY.md for prompt injection.

    The pipeline engine reads the file so every engine sees the memory
    content directly in the prompt; engines are not instructed to read or
    update the file themselves. Returns None when the file is missing/empty.
    """
    memory_file = artifacts_dir.parent / "MEMORY.md"
    try:
        if not memory_file.is_file():
            return None
        content = memory_file.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if not content:
        return None
    return content[:limit]


def _load_output_type_constraints() -> dict[str, str]:
    """Load output type constraints from the shared config file."""
    try:
        data = json.loads(_OUTPUT_TYPES_PATH.read_text(encoding="utf-8"))
        constraints: dict[str, str] = {}
        for t in data.get("types", []):
            value = t["value"]
            desc = t.get("description", _DEFAULT_CONSTRAINT)
            constraints[value] = desc
            # Also register lowercase variant for case-insensitive lookup
            constraints[value.lower()] = desc
            constraints[value.upper()] = desc
        return constraints
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return {}


OUTPUT_TYPE_CONSTRAINTS: dict[str, str] = _load_output_type_constraints()


def assemble_prompt(
    task: Task,
    step: Step,
    artifacts_dir: Path,
    user_input: str = "",
    artifact_round: int | None = None,
    input_rounds: dict[str, int] | None = None,
) -> str:
    """Assemble the full prompt for a pipeline step.

    Parts:
    1. System instruction
    2. Upstream artifact references
    3. Step-specific prompt
    4. User supplementary input
    """
    parts = [SYSTEM_PROMPT]

    memory = _load_project_memory(artifacts_dir)
    if memory:
        parts.append(f"## Project memory\n{memory}")

    if task.description:
        parts.append(f"## Task description\n{task.description}")

    if task.input_manifest_json:
        try:
            external_inputs = json.loads(task.input_manifest_json)
        except (TypeError, json.JSONDecodeError):
            external_inputs = []
        if isinstance(external_inputs, list) and external_inputs:
            parts.append(
                "## External input artifacts (from upstream tasks)\n"
                + "\n".join(
                    f"- {item.get('path')}"
                    for item in external_inputs
                    if isinstance(item, dict) and item.get("path")
                )
            )

    # Upstream artifacts
    workflow_name = task.workflow_id or "default"
    upstream = _collect_upstream_artifacts(
        task,
        step,
        artifacts_dir,
        workflow_name,
        input_rounds=input_rounds,
    )
    if upstream:
        parts.append(_format_artifact_refs(upstream))

    # Step prompt
    if step.prompt:
        parts.append(f"## Stage requirements\n{step.prompt}")

    supplements = list(
        StageSupplement.select()
        .where(
            (StageSupplement.task == task)
            & (StageSupplement.step_key == step.key)
            & (StageSupplement.active == True)
        )
        .order_by(StageSupplement.created_sequence, StageSupplement.created_at)
    )
    if supplements:
        parts.append(
            "## User-confirmed stage supplements\n"
            + "\n\n".join(item.content for item in supplements)
        )

    # Output specifications (type constraints)
    if step.outputs:
        parts.append(
            _format_output_specs(
                step.outputs,
                task.id,
                step.key,
                workflow_name,
                artifact_round=artifact_round,
            )
        )

    # User input
    if user_input:
        parts.append(f"## User input\n{user_input}")

    # Output directory (workflow / task / stage / round)
    out_dir = (
        step_round_dir(artifacts_dir, workflow_name, task.id, step.key, artifact_round)
        if artifact_round is not None
        else artifacts_dir / workflow_name / task.id / step.key
    )
    parts.append(f"## Artifact output directory\n{out_dir}")
    if step.outputs:
        out_labels = []
        for i, out in enumerate(step.outputs, 1):
            name = out.get("name", f"artifact-{i}")
            otype = out.get("type", "file")
            path_label, output_path = _output_path(out_dir, name, otype)
            suffix = "/" if path_label == "output directory" else ""
            out_labels.append(f"- {name}: {output_path}{suffix}")
        parts.append("Artifact output paths:\n" + "\n".join(out_labels))

    return "\n\n".join(parts)


def assemble_followup_prompt(
    task: Task,
    step: Step,
    artifacts_dir: Path,
    user_input: str,
    artifact_round: int | None = None,
) -> str:
    """Build a compact prompt for an existing stage engine session.

    The resumed engine session already owns the task and stage context.  A
    user ``@stage`` follow-up therefore only needs the new message plus the
    output contract that must still be honoured.
    """
    parts = [f"## User message\n{user_input.strip()}"]
    workflow_name = task.workflow_id or "default"
    out_dir = (
        step_round_dir(artifacts_dir, workflow_name, task.id, step.key, artifact_round)
        if artifact_round is not None
        else artifacts_dir / workflow_name / task.id / step.key
    )

    if step.outputs:
        paths = []
        for i, out in enumerate(step.outputs, 1):
            name = out.get("name", f"artifact-{i}")
            otype = out.get("type", "file")
            path_label, output_path = _output_path(out_dir, name, otype)
            suffix = "/" if path_label == "output directory" else ""
            paths.append(f"- {name} ({otype}): {output_path}{suffix}")
        parts.append(
            "## Artifact requirements\n"
            + _OUTPUT_GUIDANCE + "\nArtifacts that may be generated or updated this turn:\n"
            + "\n".join(paths)
        )

    return "\n\n".join(parts)


def _collect_upstream_artifacts(
    task: Task,
    step: Step,
    artifacts_dir: Path,
    workflow_name: str = "default",
    input_rounds: dict[str, int] | None = None,
) -> list[dict[str, str]]:
    """Scan selected upstream rounds for artifact files."""
    result = []
    for dep_key in step.depends_on:
        requested = (input_rounds or {}).get(dep_key)
        selected = select_upstream_round(
            artifacts_dir,
            workflow_name,
            task.id,
            dep_key,
            requested,
        )
        if selected is None:
            continue
        manifest = selected.path / "manifest.json"
        if manifest.is_file():
            result.append({
                "step": dep_key,
                "round": str(selected.round),
                "path": str(manifest),
                "name": "manifest.json",
            })
        for f in sorted(selected.path.rglob("*")):
            if f.is_file() and f.name != "manifest.json":
                result.append({
                    "step": dep_key,
                    "round": str(selected.round),
                    "path": str(f),
                    "name": f.name,
                })
    return result


def _format_artifact_refs(artifacts: list[dict[str, str]]) -> str:
    """Format artifact references as a readable block."""
    lines = ["## Upstream artifacts (completed; may be referenced)"]
    current_step = ""
    for art in artifacts:
        if art["step"] != current_step:
            current_step = art["step"]
            round_suffix = f" (round {art['round']})" if art.get("round") else ""
            lines.append(f"\n### Stage: {current_step}{round_suffix}")
        lines.append(f"- {art['path']}")
    return "\n".join(lines)


def _artifact_extension(otype: str, name: str) -> str:
    """Return the file extension for a single-file output.

    File types map to their canonical extension; untyped/file outputs fall
    back to the declared name extension, then to .txt.
    """
    extension_map = {
        "md": ".md",
        "markdown": ".md",
        "html": ".html",
        "json": ".json",
        "txt": ".txt",
        "jpg": ".jpg",
        "jpeg": ".jpg",
        "png": ".png",
        "docx": ".docx",
        "xlsx": ".xlsx",
        "csv": ".csv",
        "pdf": ".pdf",
    }
    ext = extension_map.get(str(otype).lower())
    if ext:
        return ext
    if "." in name:
        return name[name.rindex("."):]
    return ".txt"


def _output_path(out_base: str, name: str, otype: str) -> tuple[str, str]:
    """Compute the output path label and path for a single artifact.

    Directory outputs keep the trailing-slash directory; file outputs use a
    concrete single-file path with the proper extension.
    """
    if str(otype).lower() == "directory":
        return "output directory", f"{out_base}/{name}"
    return "output path", f"{out_base}/{name}{_artifact_extension(otype, name)}"


def _format_output_specs(
    outputs: list[dict],
    task_id: str,
    step_key: str,
    workflow_name: str = "default",
    *,
    artifact_round: int | None = None,
) -> str:
    """Describe optional outputs and the format required when produced."""
    lines = ["## Output specification"]
    lines.append(_OUTPUT_GUIDANCE)
    lines.append("The list below defines artifact format and output paths when generated:\n")

    round_suffix = f"/{int(artifact_round)}" if artifact_round is not None else ""
    out_base = f".workstep/artifacts/{workflow_name}/{task_id}/{step_key}{round_suffix}"

    for i, out in enumerate(outputs, 1):
        name = out.get("name", f"artifact-{i}")
        otype = out.get("type", "file")
        constraint = OUTPUT_TYPE_CONSTRAINTS.get(otype, _DEFAULT_CONSTRAINT)
        lines.append(f"{i}. **{name}**")
        lines.append(f"   - type: `{otype}`")
        lines.append(f"   - format requirement: {constraint}")
        path_label, output_path = _output_path(out_base, name, otype)
        suffix = "/" if path_label == "output directory" else ""
        lines.append(f"   - {path_label}: `{output_path}{suffix}`")

    if len(outputs) > 1:
        lines.append(_format_subagent_guidance(len(outputs)))

    lines.append(f"\nWrite generated artifacts to the matching paths under `{out_base}/`:")
    lines.append("- Directory artifact (`directory`): create a directory named `<artifact>/`; it may contain multiple files and subdirectories.")
    lines.append("- File artifact (such as `md` or `json`): write one file named `<artifact>.<extension>`; do not wrap it in another same-named directory.")
    lines.append("File extensions must match the declared output specification; do not use undeclared formats.")

    return "\n".join(lines)


def _format_subagent_guidance(count: int) -> str:
    """Suggest optional delegation when a stage declares multiple outputs."""
    return (
        f"\n### Delegation (this stage has {count} artifacts)\n"
        "Decide whether delegation is useful for this stage. Delegation is optional: you may work directly, or use subagents/subtasks only where separate or parallel work helps.\n"
        "If you delegate:\n"
        "- Keep all work in the **same conversation**; do not start a new engine session per artifact;\n"
        "- Choose the number and scope of subagents based on the work that is actually needed;\n"
        "- Give each subagent the relevant artifact name, format requirement, and output path;\n"
        "- Return useful summaries and key findings to the main conversation;\n"
        "- The main conversation aggregates results, verifies generated artifact paths, and explains any missing or empty artifact."
    )
