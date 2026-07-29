"""Seed one idempotent demo task at every workflow stage.

Usage:
    python scripts/seed_stage_kanban.py /path/to/project
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import Message, Task, TaskStep, init_db  # noqa: E402


STAGE_CONTENT = {
    "req": ("梳理业务目标、用户场景和验收标准", "需求范围已确认，正在补充异常流程和验收标准。"),
    "ui": ("根据 PRD 设计页面结构和组件规范", "主流程设计已完成，正在完善交互状态和设计令牌。"),
    "frontend": ("实现页面、状态管理和接口联调", "核心页面已完成，正在补充边界状态和组件测试。"),
    "backend": ("实现 API、数据模型和错误处理", "接口骨架已完成，正在实现数据校验和迁移脚本。"),
    "test": ("执行单元、接口和端到端测试", "测试环境已准备，正在执行关键业务链路回归。"),
    "deploy": ("执行发布检查、灰度部署和健康验证", "发布包已生成，正在进行灰度检查和线上健康验证。"),
}

STAGE_ARTIFACTS = {
    "req": [("PRD 文档", "Markdown", "prd.md"), ("原型图", "JSON", "prototype.json")],
    "ui": [("UI 设计稿", "Markdown", "ui-design.md"), ("设计规范", "JSON", "design-spec.json")],
    "frontend": [("前端页面", "JSON", "frontend-result.json"), ("状态管理", "JSON", "state-store.json"), ("单元测试", "Markdown", "unit-tests.md")],
    "backend": [("API 服务", "Markdown", "api-service.md"), ("数据库", "Markdown", "database-schema.md")],
    "test": [("测试报告", "Markdown", "test-report.md"), ("Bug 列表", "JSON", "bugs.json")],
    "deploy": [("生产环境", "JSON", "deployment-result.json")],
}

LONG_TASK_DESCRIPTION = """这是一个用于验证阶段详情长任务说明滚动效果的模拟需求。

背景：当前研发流程涉及产品、设计、前端、后端、测试和上线多个团队，任务信息分散在聊天记录、文档和看板卡片中，需要通过统一的阶段工作流保证上下游信息能够完整传递。

目标：梳理核心用户场景，明确功能范围、异常流程、非功能指标和验收标准，并产出可以直接交给后续 UI 设计与开发阶段使用的结构化需求。

范围包括：
1. 用户进入系统后的主流程和关键操作路径；
2. 权限不足、网络异常、数据为空等边界状态；
3. 页面响应速度、稳定性和兼容性要求；
4. 埋点、监控、灰度发布与回滚要求；
5. PRD、原型图和验收清单等阶段产物。

验收要求：任务说明在阶段详情中保持固定最大高度；内容超出后可在说明区域内部滚动，并且不能挤压下方的进度时间线、阶段输入输出和阶段提示词区域。"""


def load_workflow(project_path: Path) -> tuple[list[str], dict[str, str], dict[str, str]]:
    steps_path = project_path / ".workstep" / "steps.json"
    steps = json.loads(steps_path.read_text(encoding="utf-8"))
    nodes = steps.get("nodes", [])
    if nodes:
        keys = [str(node.get("type") or node.get("key")) for node in nodes]
        labels = {
            str(node.get("type") or node.get("key")): str(
                node.get("title") or node.get("label") or node.get("type")
            )
            for node in nodes
        }
        engines = {
            str(node.get("type") or node.get("key")): str(
                node.get("engine") or "claude"
            )
            for node in nodes
        }
        return keys, labels, engines

    items = steps.get("steps", [])
    keys = [str(item.get("key") or item.get("id")) for item in items]
    labels = {
        str(item.get("key") or item.get("id")): str(
            item.get("label") or item.get("name") or item.get("key")
        )
        for item in items
    }
    engines = {
        str(item.get("key") or item.get("id")): str(
            item.get("engine") or "claude"
        )
        for item in items
    }
    return keys, labels, engines


def stage_messages(task_title: str, stage_key: str, stage_label: str) -> list[tuple[str, str]]:
    goal, progress = STAGE_CONTENT.get(
        stage_key,
        (f"完成{stage_label}阶段工作", f"{stage_label}阶段正在处理中。"),
    )
    overflow_sample = ""
    if stage_key == "req":
        overflow_sample = (
            "\n\n## 长内容渲染示例\n"
            "```text\n"
            "GET /api/workflow/runs/req?"
            "project_id=test_workstep&include=events,artifacts,usage,engine_session,"
            "workflow_snapshot,recovery_state&after_sequence=1234567890\n"
            "```\n\n"
            "| 运行编号 | 阶段标识 | 执行引擎 | 默认模型 | 最近事件序号 | 产物目录 | 恢复策略 |\n"
            "| --- | --- | --- | --- | --- | --- | --- |\n"
            "| run-demo-001 | req | claude | sonnet | 1234567890 | "
            "`.workstep/artifacts/req/mock-stage-req-v1` | manual_resume |\n"
        )
    return [
        ("user", f"开始处理「{task_title}」的{stage_label}阶段。"),
        (
            "assistant",
            f"收到。\n\n## 本阶段目标\n{goal}\n\n"
            "## 执行计划\n1. 读取上游产物\n2. 完成本阶段工作\n3. 校验输出格式",
        ),
        (
            "assistant",
            f"## 当前进度\n{progress}\n\n已生成阶段模拟产物和执行记录。"
            f"{overflow_sample}",
        ),
    ]


def message_events(
    role: str,
    content: str,
    stage_key: str,
    message_index: int,
    created_at: int,
) -> list[dict]:
    """Build realistic engine events for exercising chat process folding."""
    timestamp = created_at * 1000
    events: list[dict] = []
    if role == "assistant":
        events.append({
            "type": "thinking_delta",
            "data": {
                "delta": (
                    "先读取工作流定义和上游阶段产物，再根据本阶段输出规范执行。"
                    "完成后检查产物文件是否存在，并整理结果。"
                ),
            },
            "timestamp": timestamp,
        })
        read_id = f"{stage_key}-{message_index}-read"
        events.extend([
            {
                "type": "tool_use",
                "data": {
                    "id": read_id,
                    "name": "Read",
                    "input": {"path": ".workstep/steps.json"},
                },
                "timestamp": timestamp + 100,
            },
            {
                "type": "tool_result",
                "data": {
                    "tool_use_id": read_id,
                    "content": "已读取当前项目的阶段定义与输入输出规范。",
                    "is_error": False,
                },
                "timestamp": timestamp + 200,
            },
        ])
        if message_index == 1:
            search_id = f"{stage_key}-{message_index}-search"
            events.extend([
                {
                    "type": "tool_use",
                    "data": {
                        "id": search_id,
                        "name": "Grep",
                        "input": {"pattern": "outputs", "path": ".workstep/steps.json"},
                    },
                    "timestamp": timestamp + 300,
                },
                {
                    "type": "tool_result",
                    "data": {
                        "tool_use_id": search_id,
                        "content": "已定位本阶段输出物配置。",
                        "is_error": False,
                    },
                    "timestamp": timestamp + 400,
                },
            ])
        else:
            write_id = f"{stage_key}-{message_index}-write"
            events.extend([
                {
                    "type": "tool_use",
                    "data": {
                        "id": write_id,
                        "name": "Write",
                        "input": {
                            "path": f".workstep/artifacts/{stage_key}/result.md",
                        },
                    },
                    "timestamp": timestamp + 300,
                },
                {
                    "type": "tool_result",
                    "data": {
                        "tool_use_id": write_id,
                        "content": "阶段模拟产物已写入。",
                        "is_error": False,
                    },
                    "timestamp": timestamp + 400,
                },
            ])
    events.append({
        "type": "text_delta",
        "data": {"delta": content},
        "timestamp": timestamp + 500,
    })
    return events


def seed(project_path: Path) -> None:
    workstep_dir = project_path / ".workstep"
    db_path = workstep_dir / "workstep.db"
    if not db_path.exists():
        raise SystemExit(f"WorkStep database not found: {db_path}")

    step_keys, labels, engines = load_workflow(project_path)
    if not step_keys:
        raise SystemExit("Workflow contains no stages")

    db = init_db(str(db_path))
    now = int(time.time())
    created_tasks = 0
    created_messages = 0

    try:
        with db.atomic():
            for current_index, current_key in enumerate(step_keys):
                current_label = labels[current_key]
                task_id = f"mock-stage-{current_key}-v1"
                task_title = f"[模拟] {current_label}阶段任务"
                task_description = (
                    LONG_TASK_DESCRIPTION
                    if current_index == 0
                    else f"用于验证看板中“{current_label}”阶段的展示、时间线和聊天记录。"
                )
                task, created = Task.get_or_create(
                    id=task_id,
                    defaults={
                        "title": task_title,
                        "description": task_description,
                        "cwd": str(project_path),
                        "status": "running",
                        "engine": engines[current_key],
                        "created_at": now - (len(step_keys) - current_index) * 600,
                        "updated_at": now,
                    },
                )
                if created:
                    created_tasks += 1
                else:
                    task.title = task_title
                    task.description = task_description
                    task.cwd = str(project_path)
                    task.status = "running"
                    task.engine = engines[current_key]
                    task.updated_at = now
                    task.save()

                TaskStep.delete().where(TaskStep.task == task).execute()
                Message.delete().where(Message.task == task).execute()

                position = 1
                for step_index, step_key in enumerate(step_keys):
                    status = (
                        "passed"
                        if step_index < current_index
                        else "running"
                        if step_index == current_index
                        else "pending"
                    )
                    started_at = now - (current_index - step_index + 1) * 300 if step_index <= current_index else None
                    ended_at = started_at + 180 if status == "passed" and started_at else None
                    TaskStep.create(
                        task=task,
                        step_key=step_key,
                        status=status,
                        engine=engines[step_key],
                        started_at=started_at,
                        ended_at=ended_at,
                    )

                    if step_index > current_index:
                        continue
                    stage_label = labels[step_key]
                    for message_index, (role, content) in enumerate(
                        stage_messages(task_title, step_key, stage_label)
                    ):
                        created_at = now - (current_index - step_index) * 300 + message_index * 30
                        Message.create(
                            id=f"{task_id}-{step_key}-{message_index}",
                            task=task,
                            step_key=step_key,
                            role=role,
                            content=content,
                            engine=engines[step_key],
                            run_id=f"{task_id}-{step_key}",
                            run_status="succeeded" if status == "passed" else "running",
                            events_json=json.dumps(message_events(
                                role,
                                content,
                                step_key,
                                message_index,
                                created_at,
                            ), ensure_ascii=False),
                            position=position,
                            started_at=created_at if role == "assistant" else None,
                            ended_at=created_at + 184 if role == "assistant" else None,
                            created_at=created_at,
                        )
                        position += 1
                        created_messages += 1

                    artifact_dir = workstep_dir / "artifacts" / step_key / task_id
                    artifact_dir.mkdir(parents=True, exist_ok=True)
                    artifact_specs = STAGE_ARTIFACTS.get(
                        step_key,
                        [(f"{stage_label}产物", "Markdown", "result.md")],
                    )
                    manifest_artifacts = []
                    for logical_name, artifact_type, filename in artifact_specs:
                        file_path = artifact_dir / filename
                        if filename.endswith(".json"):
                            file_path.write_text(
                                json.dumps(
                                    {
                                        "task": task_title,
                                        "stage": stage_label,
                                        "artifact": logical_name,
                                        "status": status,
                                        "mock": True,
                                    },
                                    ensure_ascii=False,
                                    indent=2,
                                ),
                                encoding="utf-8",
                            )
                        else:
                            file_path.write_text(
                                f"# {logical_name}\n\n"
                                f"- 任务：{task_title}\n"
                                f"- 阶段：{stage_label} (`{step_key}`)\n"
                                f"- 状态：{status}\n\n"
                                "这是用于 WorkStep 文件预览联调的模拟产物内容。\n",
                                encoding="utf-8",
                            )
                        manifest_artifacts.append({
                            "name": logical_name,
                            "type": artifact_type,
                            "path": filename,
                        })
                    (artifact_dir / "manifest.json").write_text(
                        json.dumps(
                            {
                                "schema_version": 1,
                                "task_id": task_id,
                                "step_key": step_key,
                                "status": status,
                                "artifacts": manifest_artifacts,
                            },
                            ensure_ascii=False,
                            indent=2,
                        ),
                        encoding="utf-8",
                    )

                print(f"{current_key}: {task_title}")
    finally:
        db.close()

    print(
        f"Seed complete: {created_tasks} new tasks, "
        f"{created_messages} refreshed messages, {len(step_keys)} stages"
    )


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "/Users/xzr/Desktop/test_workstep")
    seed(target.resolve())
