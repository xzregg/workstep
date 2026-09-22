"""Prompt assembly — builds the full prompt for each pipeline step."""

import json
import re
from pathlib import Path

from models import StepSupplement
from models.task import Task
from services.artifact_rounds import select_upstream_round, step_round_dir
from services.pipeline import Step

# Config path relative to this file
_OUTPUT_TYPES_PATH = Path(__file__).resolve().parent.parent / "data" / "output-types.json"
_DEFAULT_CONSTRAINT = "Generic UTF-8 text; clear structure and directly readable."
_OUTPUT_GUIDANCE = "Decide from the step requirements and available context whether outputs are ready. If information is insufficient, you may omit artifacts or leave them empty; do not invent filler or placeholders just to satisfy the output list. Explain the reason in your reply. Generated artifacts must keep their declared names, types, and paths."

# System prompt injected at the start of every step
SYSTEM_PROMPT = """You are executing one step in a WorkStep workflow.
Work in the current project root and complete only the step requirements.
When an output specification is present, follow its artifact contract."""

_STEP_TEMPLATE_VARIABLE = re.compile(
    r"\{([a-z][a-z0-9_]*)\}|｛([a-z][a-z0-9_]*)｝",
    re.IGNORECASE,
)


def render_step_prompt(
    template: str,
    task: Task,
    step: Step,
    trigger_name: str = "",
) -> str:
    """Render supported task and step variables in a step prompt template."""
    effective_trigger_name = trigger_name or task.creator_name or ""
    values = {
        "name": effective_trigger_name,
        "trigger_name": effective_trigger_name,
        "creator_name": task.creator_name or "",
        "task_creator_name": task.creator_name or "",
        "task_title": task.title or "",
        "task_description": task.description or "",
        "step_name": step.label or "",
        "step_key": step.key or "",
    }

    def replace(match: re.Match[str]) -> str:
        key = (match.group(1) or match.group(2)).lower()
        return str(values[key]) if key in values else match.group(0)

    return _STEP_TEMPLATE_VARIABLE.sub(replace, template)

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
    input_snapshot: dict | None = None,
    trigger_name: str = "",
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

    task_description = _task_description_for_prompt(task)
    if task_description:
        parts.append(f"## Task description\n{task_description}")

    if task.input_manifest_json:
        try:
            external_inputs = json.loads(task.input_manifest_json)
        except (TypeError, json.JSONDecodeError):
            external_inputs = []
        if isinstance(external_inputs, list) and external_inputs:
            formatted_inputs = _format_external_inputs(external_inputs)
            if formatted_inputs:
                parts.append(formatted_inputs)

    # Upstream artifacts
    workflow_name = task.workflow_id or "default"
    out_dir = (
        step_round_dir(artifacts_dir, workflow_name, task.id, step.key, artifact_round)
        if artifact_round is not None
        else artifacts_dir / workflow_name / task.id / step.key
    )
    if input_snapshot is not None:
        parts.append(_format_input_snapshot(input_snapshot))
    else:
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
        parts.append(
            "## Step requirements\n"
            + render_step_prompt(step.prompt, task, step, trigger_name)
        )

    supplements = [
        item
        for item in (
            StepSupplement.select()
            .where(
                (StepSupplement.task == task)
                & (StepSupplement.step_key == step.key)
                & (StepSupplement.active == True)
            )
            .order_by(
                StepSupplement.created_sequence,
                StepSupplement.created_at,
            )
        )
        if item.source_proposal_id is not None
        or item.origin == "live_guidance"
    ]
    if supplements:
        parts.append(
            "## User-confirmed step supplements\n"
            + "\n\n".join(item.content for item in supplements)
        )

    # Output specifications (type constraints)
    if step.outputs:
        parts.append(
            _format_output_specs(
                step.outputs,
                out_dir,
                step.outgoing_connections,
            )
        )

    # User input
    if user_input:
        parts.append(f"## User input\n{user_input}")

    if not step.outputs:
        parts.append(f"## Artifact output directory\n{out_dir}")

    return "\n\n".join(parts)


def _task_description_for_prompt(task: Task) -> str:
    """Return user-authored task text without legacy dispatch metadata."""
    description = str(task.description or "").strip()
    if task.source_dispatch_id and "\n## 来源任务" in description:
        description = description.split("\n## 来源任务", 1)[0].rstrip()
    return description


def _format_external_inputs(inputs: list[dict]) -> str:
    """Render dispatched artifacts as useful inputs, hiding internal lineage IDs."""
    blocks: list[str] = []
    for item in inputs:
        if not isinstance(item, dict) or not item.get("path"):
            continue
        name = str(item.get("name") or Path(str(item["path"])).name or "artifact")
        lines = [f"### Input: {name}"]
        if item.get("source_step_key"):
            lines.append(f"- Source step: `{item['source_step_key']}`")
        if item.get("source_round") is not None:
            lines.append(f"- Source round: {item['source_round']}")
        lines.append(f"- Path: `{item['path']}`")
        blocks.append("\n".join(lines))
    if not blocks:
        return ""
    return "## Upstream task inputs\n" + "\n\n".join(blocks)


def _format_input_snapshot(snapshot: dict) -> str:
    """Render runtime inputs as a semantic contract, not graph internals."""
    execution_type = str(snapshot.get("execution_type") or "forward")
    reason = {
        "initial": "initial_execution",
        "forward": "upstream_ready",
        "feedback": "feedback_revision",
    }.get(execution_type, execution_type)
    lines = [
        "## Step execution context",
        f"Execution reason: `{reason}`",
    ]
    for port in snapshot.get("ports", []):
        if not isinstance(port, dict):
            continue
        index = port.get("port")
        name = str(port.get("name") or f"input-{index}")
        status = str(port.get("status") or "inactive")
        lines.extend([
            "",
            f"### Input: {name}",
        ])
        sources = port.get("sources") or []
        if not sources:
            availability = {
                "task_context": "Use the task description and step requirements.",
                "inactive": "No artifact is available for this input in this execution.",
            }.get(status, "No artifact is available for this input.")
            lines.append(f"- Availability: {availability}")
            continue
        for source in sources:
            if not isinstance(source, dict):
                continue
            if source.get("step"):
                lines.append(f"- Source step: `{source['step']}`")
            if source.get("round") is not None:
                lines.append(f"- Source round: {source['round']}")
            if source.get("name"):
                lines.append(f"- Artifact: {source['name']}")
            if source.get("path"):
                if source.get("is_dir") or str(source.get("type") or "").lower() == "directory":
                    lines.append(f"- Directory: `{source['path']}`")
                    lines.append(
                        "- Usage: Inspect this directory and read the files required for this step."
                    )
                else:
                    lines.append(f"- Path: `{source['path']}`")
            if source.get("kind") == "dashed":
                lines.append("- Purpose: revise the affected work using this feedback artifact.")
    return "\n".join(lines)


def assemble_followup_prompt(
    task: Task,
    step: Step,
    artifacts_dir: Path,
    user_input: str,
    artifact_round: int | None = None,
    trigger_name: str = "",
) -> str:
    """Build a compact prompt for an existing step engine session.

    The resumed engine session already owns the task and step context.  A
    user ``@step`` follow-up therefore only needs the new message plus the
    output contract that must still be honoured.
    """
    parts = []
    if trigger_name:
        parts.append(f"## Triggered by\n{trigger_name}")
    parts.append(f"## User message\n{user_input.strip()}")
    workflow_name = task.workflow_id or "default"
    out_dir = (
        step_round_dir(artifacts_dir, workflow_name, task.id, step.key, artifact_round)
        if artifact_round is not None
        else artifacts_dir / workflow_name / task.id / step.key
    )

    if step.outputs:
        parts.append(
            _format_output_specs(
                step.outputs,
                out_dir,
                step.outgoing_connections,
                heading="Artifact requirements",
            )
        )

    return "\n\n".join(parts)


def assemble_retry_prompt(
    task: Task,
    step: Step,
    artifacts_dir: Path,
    input_snapshot: dict,
    artifact_round: int | None = None,
) -> str:
    """Build the incremental contract for a resumed review/feedback revision.

    The engine session already contains the task and step instructions.  A
    retry only needs the inputs that are effective now and the new round's
    exact output destinations.
    """
    workflow_name = task.workflow_id or "default"
    out_dir = (
        step_round_dir(artifacts_dir, workflow_name, task.id, step.key, artifact_round)
        if artifact_round is not None
        else artifacts_dir / workflow_name / task.id / step.key
    )
    parts = [
        "## Step execution update\n"
        "Continue in the existing step session and revise the previous result."
    ]
    if input_snapshot:
        parts.append(_format_input_snapshot(input_snapshot))
    if step.outputs:
        parts.append(
            _format_output_specs(
                step.outputs,
                out_dir,
                step.outgoing_connections,
            )
        )
    else:
        parts.append(f"## Artifact output directory\n{out_dir}")
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
            lines.append(f"\n### Step: {current_step}{round_suffix}")
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
    out_base: str | Path,
    outgoing_connections: list[dict] | None = None,
    *,
    heading: str = "Output specification",
) -> str:
    """Describe optional outputs once, including their exact destination."""
    lines = [f"## {heading}"]
    lines.append(_OUTPUT_GUIDANCE)
    lines.append("The list below defines each artifact's format and exact output path when generated:\n")
    out_base = str(out_base)

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
        routes = [
            connection
            for connection in (outgoing_connections or [])
            if int(connection.get("fromPort", 0)) == i - 1
        ]
        for connection in routes:
            target = str(connection.get("to") or "the target step")
            if connection.get("kind", "solid") == "dashed":
                lines.append(
                    "   - routing: generate only when revision is required; when non-empty, "
                    f"requests revision of step `{target}`."
                )
            else:
                lines.append(
                    "   - routing: when non-empty, "
                    f"continues the workflow to step `{target}`."
                )

    route_kinds = {
        str(connection.get("kind", "solid"))
        for connection in (outgoing_connections or [])
    }
    if "dashed" in route_kinds and any(kind != "dashed" for kind in route_kinds):
        lines.append(
            "\nForward-result artifacts and feedback artifacts must not both be generated "
            "in the same execution; doing so creates a routing conflict."
        )

    if any(str(out.get("type", "file")).lower() != "directory" for out in outputs):
        lines.append("\nFor each file artifact, write one file directly at its declared output path; do not wrap it in another same-named directory or use another extension.")

    return "\n".join(lines)
