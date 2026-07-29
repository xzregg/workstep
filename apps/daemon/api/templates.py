"""Workflow templates API - browse and apply templates."""

import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from schemas.base import BaseSchema
from services.workflow_definition import (
    WorkflowDefinition,
    WorkflowValidationError,
)

router = APIRouter(prefix="/api/templates")

# Default templates directory
TEMPLATES_DIR = Path(__file__).parent.parent / "data" / "templates"
TEMPLATE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _validate_template_id(template_id: str):
    if not TEMPLATE_ID_PATTERN.fullmatch(template_id):
        raise HTTPException(
            status_code=422,
            detail="Template id must contain only letters, numbers, '_' or '-'",
        )


class Template(BaseSchema):
    id: str
    name: str
    description: str
    steps: dict  # The full steps.json content


# Built-in templates
BUILTIN_TEMPLATES = [
    {
        "id": "dev-workflow",
        "name": "研发流程（默认）",
        "description": "需求 → UI设计 → 前端/后端并行 → 测试 → 上线",
        "steps": {
            "nodes": [
                {"id": 1, "type": "req", "title": "需求", "position": {"x": 100, "y": 200},
                 "engine": "claude", "model": "",
                 "prompt": "根据业务需求和用户调研，产出 PRD 文档和原型图。明确用户场景、功能点、验收标准。",
                 "inputs": [{"name": "业务需求", "type": "文档", "outputs": [{"name": "PRD 文档", "type": "Markdown"}, {"name": "原型图", "type": "Figma"}]}],
                 "outputs": [{"name": "PRD 文档", "type": "Markdown"}, {"name": "原型图", "type": "Figma"}]},
                {"id": 2, "type": "ui", "title": "UI 设计", "position": {"x": 380, "y": 200},
                 "engine": "claude", "model": "",
                 "prompt": "根据 PRD 和原型图，设计高保真 UI 界面，产出设计稿和设计规范文档。",
                 "inputs": [{"name": "PRD 文档", "type": "Markdown", "outputs": [{"name": "UI 设计稿", "type": "Figma"}, {"name": "设计规范", "type": "PDF"}]}],
                 "outputs": [{"name": "UI 设计稿", "type": "Figma"}, {"name": "设计规范", "type": "PDF"}]},
                {"id": 3, "type": "frontend", "title": "前端开发", "position": {"x": 660, "y": 100},
                 "engine": "claude", "model": "",
                 "prompt": "根据 UI 设计稿和设计规范，开发前端页面，实现状态管理和单元测试。",
                 "inputs": [{"name": "UI 设计稿", "type": "Figma", "outputs": [{"name": "前端页面", "type": "React"}, {"name": "状态管理", "type": "Zustand"}, {"name": "单元测试", "type": "Vitest"}]},
                            {"name": "设计规范", "type": "PDF", "outputs": []}],
                 "outputs": [{"name": "前端页面", "type": "React"}, {"name": "状态管理", "type": "Zustand"}, {"name": "单元测试", "type": "Vitest"}]},
                {"id": 4, "type": "backend", "title": "后端开发", "position": {"x": 660, "y": 300},
                 "engine": "codex", "model": "gpt-5.5",
                 "prompt": "根据设计规范，开发后端 API 服务，设计数据库表结构。",
                 "inputs": [{"name": "设计规范", "type": "PDF", "outputs": [{"name": "API 服务", "type": "Go"}, {"name": "数据库", "type": "MySQL"}]}],
                 "outputs": [{"name": "API 服务", "type": "Go"}, {"name": "数据库", "type": "MySQL"}]},
                {"id": 5, "type": "test", "title": "测试", "position": {"x": 940, "y": 200},
                 "engine": "codex", "model": "",
                 "prompt": "对前端页面和后端 API 进行集成测试，产出测试报告和 Bug 列表。",
                 "inputs": [{"name": "前端页面", "type": "React", "outputs": [{"name": "测试报告", "type": "HTML"}, {"name": "Bug 列表", "type": "Excel"}]},
                            {"name": "API 服务", "type": "Go", "outputs": []}],
                 "outputs": [{"name": "测试报告", "type": "HTML"}, {"name": "Bug 列表", "type": "Excel"}]},
                {"id": 6, "type": "deploy", "title": "上线", "position": {"x": 1220, "y": 200},
                 "engine": "hermes", "model": "grok-4.3",
                 "prompt": "根据测试报告和部署文档，将服务部署到生产环境。",
                 "inputs": [{"name": "测试报告", "type": "HTML", "outputs": [{"name": "生产环境", "type": "K8s"}]}],
                 "outputs": [{"name": "生产环境", "type": "K8s"}]},
            ],
            "connections": [
                {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
                {"from": 2, "fromPort": 0, "to": 3, "toPort": 0},
                {"from": 2, "fromPort": 1, "to": 3, "toPort": 1},
                {"from": 2, "fromPort": 1, "to": 4, "toPort": 0},
                {"from": 3, "fromPort": 0, "to": 5, "toPort": 0},
                {"from": 4, "fromPort": 0, "to": 5, "toPort": 1},
                {"from": 5, "fromPort": 0, "to": 6, "toPort": 0},
            ],
        },
    },
    {
        "id": "writing-workflow",
        "name": "写作流程",
        "description": "选题 → 大纲 → 初稿 → 审校 → 排版",
        "steps": {
            "nodes": [
                {"id": 1, "type": "topic", "title": "选题", "position": {"x": 100, "y": 200},
                 "engine": "claude", "model": "",
                 "prompt": "根据目标读者和主题方向，确定文章选题和核心观点。",
                 "inputs": [{"name": "主题方向", "type": "文档", "outputs": [{"name": "选题报告", "type": "Markdown"}]}],
                 "outputs": [{"name": "选题报告", "type": "Markdown"}]},
                {"id": 2, "type": "outline", "title": "大纲", "position": {"x": 380, "y": 200},
                 "engine": "claude", "model": "",
                 "prompt": "根据选题报告，撰写详细文章大纲，包括各章节要点。",
                 "inputs": [{"name": "选题报告", "type": "Markdown", "outputs": [{"name": "文章大纲", "type": "Markdown"}]}],
                 "outputs": [{"name": "文章大纲", "type": "Markdown"}]},
                {"id": 3, "type": "draft", "title": "初稿", "position": {"x": 660, "y": 200},
                 "engine": "claude", "model": "",
                 "prompt": "根据文章大纲，撰写完整初稿。",
                 "inputs": [{"name": "文章大纲", "type": "Markdown", "outputs": [{"name": "文章初稿", "type": "Markdown"}]}],
                 "outputs": [{"name": "文章初稿", "type": "Markdown"}]},
                {"id": 4, "type": "review", "title": "审校", "position": {"x": 940, "y": 200},
                 "engine": "claude", "model": "",
                 "prompt": "审校文章初稿，修正错误，优化表达。",
                 "inputs": [{"name": "文章初稿", "type": "Markdown", "outputs": [{"name": "审校稿", "type": "Markdown"}]}],
                 "outputs": [{"name": "审校稿", "type": "Markdown"}]},
                {"id": 5, "type": "format", "title": "排版", "position": {"x": 1220, "y": 200},
                 "engine": "claude", "model": "",
                 "prompt": "对审校稿进行最终排版，输出发布版本。",
                 "inputs": [{"name": "审校稿", "type": "Markdown", "outputs": [{"name": "发布版", "type": "Markdown"}]}],
                 "outputs": [{"name": "发布版", "type": "Markdown"}]},
            ],
            "connections": [
                {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
                {"from": 2, "fromPort": 0, "to": 3, "toPort": 0},
                {"from": 3, "fromPort": 0, "to": 4, "toPort": 0},
                {"from": 4, "fromPort": 0, "to": 5, "toPort": 0},
            ],
        },
    },
    {
        "id": "data-workflow",
        "name": "数据流程",
        "description": "数据采集 → 清洗 → 建模 → 评估 → 报告",
        "steps": {
            "nodes": [
                {"id": 1, "type": "collect", "title": "数据采集", "position": {"x": 100, "y": 200},
                 "engine": "claude", "model": "",
                 "prompt": "根据数据需求，设计数据采集方案并执行。",
                 "inputs": [{"name": "数据需求", "type": "文档", "outputs": [{"name": "原始数据", "type": "CSV"}]}],
                 "outputs": [{"name": "原始数据", "type": "CSV"}]},
                {"id": 2, "type": "clean", "title": "数据清洗", "position": {"x": 380, "y": 200},
                 "engine": "codex", "model": "",
                 "prompt": "清洗原始数据，处理缺失值、异常值，标准化格式。",
                 "inputs": [{"name": "原始数据", "type": "CSV", "outputs": [{"name": "清洗数据", "type": "CSV"}]}],
                 "outputs": [{"name": "清洗数据", "type": "CSV"}]},
                {"id": 3, "type": "model", "title": "建模", "position": {"x": 660, "y": 200},
                 "engine": "codex", "model": "",
                 "prompt": "基于清洗后的数据，训练机器学习模型。",
                 "inputs": [{"name": "清洗数据", "type": "CSV", "outputs": [{"name": "模型文件", "type": "Pickle"}, {"name": "训练日志", "type": "Markdown"}]}],
                 "outputs": [{"name": "模型文件", "type": "Pickle"}, {"name": "训练日志", "type": "Markdown"}]},
                {"id": 4, "type": "evaluate", "title": "评估", "position": {"x": 940, "y": 200},
                 "engine": "codex", "model": "",
                 "prompt": "评估模型性能，生成评估报告。",
                 "inputs": [{"name": "模型文件", "type": "Pickle", "outputs": [{"name": "评估报告", "type": "Markdown"}]}],
                 "outputs": [{"name": "评估报告", "type": "Markdown"}]},
                {"id": 5, "type": "report", "title": "报告", "position": {"x": 1220, "y": 200},
                 "engine": "claude", "model": "",
                 "prompt": "汇总整个数据分析流程，生成最终报告。",
                 "inputs": [{"name": "评估报告", "type": "Markdown", "outputs": [{"name": "最终报告", "type": "Markdown"}]}],
                 "outputs": [{"name": "最终报告", "type": "Markdown"}]},
            ],
            "connections": [
                {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
                {"from": 2, "fromPort": 0, "to": 3, "toPort": 0},
                {"from": 3, "fromPort": 0, "to": 4, "toPort": 0},
                {"from": 4, "fromPort": 0, "to": 5, "toPort": 0},
            ],
        },
    },
    {
        "id": "blank",
        "name": "空白模板",
        "description": "从零开始创建工作流",
        "steps": {"nodes": [], "connections": []},
    },
]


@router.get("/list")
async def list_templates():
    """List all available workflow templates."""
    templates = []
    for t in BUILTIN_TEMPLATES:
        templates.append({
            "id": t["id"],
            "name": t["name"],
            "description": t["description"],
            "nodeCount": len(t["steps"].get("nodes", [])),
        })

    # Also load custom templates from data/templates/
    if TEMPLATES_DIR.exists():
        for f in TEMPLATES_DIR.glob("*.json"):
            try:
                data = json.loads(f.read_text())
                templates.append({
                    "id": data.get("id", f.stem),
                    "name": data.get("name", f.stem),
                    "description": data.get("description", ""),
                    "nodeCount": len(data.get("steps", {}).get("nodes", [])),
                    "custom": True,
                })
            except Exception:
                pass

    return {"templates": templates}


@router.get("/{template_id}")
async def get_template(template_id: str):
    """Get a specific template by ID."""
    _validate_template_id(template_id)
    # Check built-in templates
    for t in BUILTIN_TEMPLATES:
        if t["id"] == template_id:
            return t

    # Check custom templates
    custom_path = TEMPLATES_DIR / f"{template_id}.json"
    if custom_path.exists():
        try:
            data = json.loads(custom_path.read_text())
            return data
        except Exception:
            pass

    raise HTTPException(status_code=404, detail=f"Template not found: {template_id}")


class SaveTemplateRequest(BaseSchema):
    id: str
    name: str
    description: str
    steps: dict


@router.post("/save")
async def save_template(req: SaveTemplateRequest):
    """Save a custom template."""
    _validate_template_id(req.id)
    try:
        WorkflowDefinition.load(req.steps).validate()
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    path = TEMPLATES_DIR / f"{req.id}.json"
    path.write_text(json.dumps({
        "id": req.id,
        "name": req.name,
        "description": req.description,
        "steps": req.steps,
    }, ensure_ascii=False, indent=2))
    return {"saved": True, "id": req.id}
