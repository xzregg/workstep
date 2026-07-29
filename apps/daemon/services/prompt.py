"""Prompt assembly — builds the full prompt for each pipeline step."""

from pathlib import Path

from models.task import Task
from services.pipeline import Step

# System prompt injected at the start of every step
SYSTEM_PROMPT = """你是 WorkStep 工作流中的一个执行阶段。
请根据阶段要求完成任务，产出指定的产物文件。
工作目录是当前项目根目录。
产物请写入 .workstep/artifacts/<step_key>/<task_id>/ 目录下。"""


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
