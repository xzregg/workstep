"""Prompt assembly — builds the full prompt for each pipeline step."""

import json
from pathlib import Path

from models.task import Task
from services.pipeline import Step

# Config path relative to this file
_OUTPUT_TYPES_PATH = Path(__file__).resolve().parent.parent / "data" / "output-types.json"
_DEFAULT_CONSTRAINT = "UTF-8 编码的通用文本文件，内容结构清晰、可直接阅读。"

# System prompt injected at the start of every step
SYSTEM_PROMPT = """你是 WorkStep 工作流中的一个执行阶段。
请根据阶段要求完成任务，产出指定的产物文件。
工作目录是当前项目根目录。
产物请写入 .workstep/artifacts/<step_key>/<task_id>/ 目录下。

严格按「输出规范」中声明的文件类型和名称产出产物，不要输出未声明的文件格式。"""


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
) -> str:
    """Assemble the full prompt for a pipeline step.

    Parts:
    1. System instruction
    2. Upstream artifact references
    3. Step-specific prompt
    4. User supplementary input
    """
    parts = [SYSTEM_PROMPT]

    if task.description:
        parts.append(f"## 任务说明\n{task.description}")

    # Upstream artifacts
    upstream = _collect_upstream_artifacts(task, step, artifacts_dir)
    if upstream:
        parts.append(_format_artifact_refs(upstream))

    # Step prompt
    if step.prompt:
        parts.append(f"## 阶段要求\n{step.prompt}")

    # Output specifications (type constraints)
    if step.outputs:
        parts.append(_format_output_specs(step.outputs))

    # User input
    if user_input:
        parts.append(f"## 用户输入\n{user_input}")

    # Output directory
    out_dir = artifacts_dir / step.key / task.id
    parts.append(f"## 产物输出目录\n{out_dir}")

    return "\n\n".join(parts)


def _collect_upstream_artifacts(
    task: Task,
    step: Step,
    artifacts_dir: Path,
) -> list[dict[str, str]]:
    """Scan upstream dependency directories for artifact files."""
    result = []
    for dep_key in step.depends_on:
        dep_dir = artifacts_dir / dep_key / task.id
        if dep_dir.is_dir():
            for f in sorted(dep_dir.rglob("*")):
                if f.is_file():
                    result.append({
                        "step": dep_key,
                        "path": str(f),
                        "name": f.name,
                    })
    return result


def _format_artifact_refs(artifacts: list[dict[str, str]]) -> str:
    """Format artifact references as a readable block."""
    lines = ["## 上游产物（已完成，可引用）"]
    current_step = ""
    for art in artifacts:
        if art["step"] != current_step:
            current_step = art["step"]
            lines.append(f"\n### 阶段: {current_step}")
        lines.append(f"- {art['path']}")
    return "\n".join(lines)


def _format_output_specs(outputs: list[dict]) -> str:
    """Format output specifications as strict constraints for the LLM."""
    lines = ["## 输出规范（必须严格遵守）"]
    lines.append("请按以下列表精确产出文件，每个产物写入指定的文件路径：\n")

    for i, out in enumerate(outputs, 1):
        name = out.get("name", f"产物{i}")
        otype = out.get("type", "file")
        constraint = OUTPUT_TYPE_CONSTRAINTS.get(otype, OUTPUT_TYPE_CONSTRAINTS["file"])
        lines.append(f"{i}. **{name}**")
        lines.append(f"   - 类型: `{otype}`")
        lines.append(f"   - 格式要求: {constraint}")

    lines.append(f"\n所有产物必须写入 `.workstep/artifacts/<step_key>/<task_id>/` 目录。")
    lines.append("不要产出「输出规范」中未声明的文件类型或额外文件。")

    return "\n".join(lines)
