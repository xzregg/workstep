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
请根据阶段要求完成任务，产出指定的产物内容。
工作目录是当前项目根目录。
产物按「输出规范」写入 .workstep/artifacts/<工作流>/<任务>/<阶段>/ 下。
判定规则：目录型产物（类型为 directory）才创建同名目录 <产物名>/；文件型产物（如 md/json 等带后缀类型）直接写入单个文件 <产物名>.<扩展名>，不要再为它包一层同名目录。

严格按「输出规范」中声明的类型和名称产出产物。"""


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
        parts.append(f"## 项目记忆\n{memory}")

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

    # Output directory (workflow / task / stage /)
    out_dir = artifacts_dir / workflow_name / task.id / step.key
    parts.append(f"## 产物输出目录\n{out_dir}")
    if step.outputs:
        out_labels = []
        for i, out in enumerate(step.outputs, 1):
            name = out.get("name", f"产物{i}")
            otype = out.get("type", "file")
            path_label, output_path = _output_path(out_dir, name, otype)
            suffix = "/" if path_label == "输出目录" else ""
            out_labels.append(f"- {name}: {output_path}{suffix}")
        parts.append("各产物写入路径:\n" + "\n".join(out_labels))

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
        return "输出目录", f"{out_base}/{name}"
    return "输出路径", f"{out_base}/{name}{_artifact_extension(otype, name)}"


def _format_output_specs(outputs: list[dict], task_id: str, step_key: str, workflow_name: str = "default") -> str:
    """Format output specifications as strict constraints for the LLM."""
    lines = ["## 输出规范（必须严格遵守）"]
    lines.append("请按以下列表精确产出内容，每个产物写入指定的输出路径：\n")

    out_base = f".workstep/artifacts/{workflow_name}/{task_id}/{step_key}"

    for i, out in enumerate(outputs, 1):
        name = out.get("name", f"产物{i}")
        otype = out.get("type", "file")
        constraint = OUTPUT_TYPE_CONSTRAINTS.get(otype, _DEFAULT_CONSTRAINT)
        lines.append(f"{i}. **{name}**")
        lines.append(f"   - 类型: `{otype}`")
        lines.append(f"   - 格式要求: {constraint}")
        path_label, output_path = _output_path(out_base, name, otype)
        suffix = "/" if path_label == "输出目录" else ""
        lines.append(f"   - {path_label}: `{output_path}{suffix}`")

    if len(outputs) > 1:
        lines.append(_format_subagent_guidance(len(outputs)))

    lines.append(f"\n每个产物写入 `{out_base}/` 下的对应路径：")
    lines.append("- 目录型产物（类型为 `directory`）：创建同名目录 `<产物名>/`，目录内可含多个文件和子目录（按需）。")
    lines.append("- 文件型产物（如 `md`、`json` 等带后缀类型）：直接产出 `<产物名>.<扩展名>` 单个文件，不要为文件型产物再创建同名子目录。")
    lines.append("文件的扩展名必须与「输出规范」中的类型一致，避免使用未声明的文件格式。")

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
        "- 主会话汇总所有子代理结果，并核验每个产物都已写入对应的输出路径。"
    )
