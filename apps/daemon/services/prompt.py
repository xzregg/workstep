"""Prompt assembly — builds the full prompt for each pipeline step."""

import json
from pathlib import Path

from models import StageSupplement
from models.task import Task
from services.pipeline import Step

# Config path relative to this file
_OUTPUT_TYPES_PATH = Path(__file__).resolve().parent.parent / "data" / "output-types.json"
_DEFAULT_CONSTRAINT = "UTF-8 编码的通用文本文件，内容结构清晰、可直接阅读。"

# System prompt injected at the start of every step
SYSTEM_PROMPT = """你是 WorkStep 工作流中的一个执行阶段。
请根据阶段要求完成任务，产出指定的产物文件。
工作目录是当前项目根目录。
产物请写入 .workstep/artifacts/<工作流>/<任务>/<阶段>/<产物名>/ 目录下。
开始前请先查看项目根目录的 .workstep/MEMORY.md（如果存在），
遵循其中记录的项目记忆、约定与阶段性结论；如产生新的关键结论，请更新该文件。

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
    workflow_name = task.workflow_id or "default"
    upstream = _collect_upstream_artifacts(task, step, artifacts_dir, workflow_name)
    if upstream:
        parts.append(_format_artifact_refs(upstream))

    # Step prompt
    if step.prompt:
        parts.append(f"## 阶段要求\n{step.prompt}")

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
            "## 用户确认的阶段补充\n"
            + "\n\n".join(item.content for item in supplements)
        )

    # Output specifications (type constraints)
    if step.outputs:
        parts.append(_format_output_specs(step.outputs, task.id, step.key, workflow_name))

    # User input
    if user_input:
        parts.append(f"## 用户输入\n{user_input}")

    # Output directory (workflow / task / stage / output_name /)
    out_dir = artifacts_dir / workflow_name / task.id / step.key
    parts.append(f"## 产物输出目录\n{out_dir}")
    if step.outputs:
        out_labels = []
        for out in step.outputs:
            name = out.get("name", f"产物{out_labels.__len__() + 1}")
            out_labels.append(f"- {name}: {out_dir / name}/")
        parts.append("各产物写入对应子目录:\n" + "\n".join(out_labels))

    return "\n\n".join(parts)


def _collect_upstream_artifacts(
    task: Task,
    step: Step,
    artifacts_dir: Path,
    workflow_name: str = "default",
) -> list[dict[str, str]]:
    """Scan upstream dependency directories for artifact files."""
    result = []
    for dep_key in step.depends_on:
        dep_base = artifacts_dir / workflow_name / task.id / dep_key
        if dep_base.is_dir():
            for f in sorted(dep_base.rglob("*")):
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


def _format_output_specs(outputs: list[dict], task_id: str, step_key: str, workflow_name: str = "default") -> str:
    """Format output specifications as strict constraints for the LLM."""
    lines = ["## 输出规范（必须严格遵守）"]
    lines.append("请按以下列表精确产出文件，每个产物写入指定的文件路径：\n")

    out_base = f".workstep/artifacts/{workflow_name}/{task_id}/{step_key}"

    for i, out in enumerate(outputs, 1):
        name = out.get("name", f"产物{i}")
        otype = out.get("type", "file")
        constraint = OUTPUT_TYPE_CONSTRAINTS.get(otype, _DEFAULT_CONSTRAINT)
        lines.append(f"{i}. **{name}**")
        lines.append(f"   - 类型: `{otype}`")
        lines.append(f"   - 格式要求: {constraint}")
        lines.append(f"   - 输出路径: `{out_base}/{name}/`")

    if len(outputs) > 1:
        lines.append(_format_subagent_guidance(len(outputs)))

    lines.append(f"\n每个产物必须写入对应的子目录 `{out_base}/<产物名>/` 中。")
    lines.append("不要产出「输出规范」中未声明的文件类型或额外文件。")

    return "\n".join(lines)


def _format_subagent_guidance(count: int) -> str:
    """Guide the main engine to produce each output via a subagent in one session."""
    return (
        f"\n### 分工方式（本阶段共 {count} 个产物）\n"
        "本阶段的所有产物必须在**同一个会话**内完成，不要为每个产物启动新的引擎会话。\n"
        "推荐调用你的「子代理 / 子任务」工具，为每个产物分别派发一个子代理执行：\n"
        f"- 共派发 {count} 个子代理，每个子代理只负责一个产物；\n"
        "- 子代理入参中写明：产物名称、格式要求与输出路径；\n"
        "- 子代理执行结束后，把它的产出摘要、关键结论与耗时作为工具返回内容交回主会话；\n"
        "- 主会话汇总所有子代理结果，并核验每个产物都已写入对应子目录。"
    )
