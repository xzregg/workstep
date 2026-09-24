"""Validate and publish workflow-level Action shortcuts."""

import json
from pathlib import Path

from models import Workflow
from models.fields import utc_now
from services.quick_buttons import ACTION_ID, normalize_quick_buttons, valid_script_path


def normalize_action_payload(payload: dict) -> dict:
    action_id = str(payload.get("action_id") or "").strip()
    title = str(payload.get("title") or payload.get("label") or "").strip()
    script_path = str(payload.get("script_path") or "").strip()
    script_content = payload.get("script_content")
    if not ACTION_ID.fullmatch(action_id) or not title or len(title) > 1000:
        raise ValueError("Action 名称或 ID 无效")
    if not valid_script_path(script_path) or not isinstance(script_content, str):
        raise ValueError("Action 脚本无效")
    if Path(script_path).name != script_path or Path(script_path).suffix not in {".sh", ".bash", ".py"}:
        raise ValueError("Action 脚本必须是 .sh、.bash 或 .py 文件名")
    if not script_content.strip() or len(script_content.encode("utf-8")) > 128 * 1024:
        raise ValueError("Action 脚本为空或过大")
    button = normalize_quick_buttons([{
        "id": action_id, "kind": "action", "label": title,
        "action_id": action_id, "script_path": script_path,
        "cwd_mode": payload.get("cwd_mode") or "task",
        "require_confirmation": payload.get("require_confirmation") is not False,
    }])[0]
    return {**button, "script_content": script_content}


def create_workflow_action(project, workflow_id: str, payload: dict) -> dict:
    """Run inside the project's database executor; never overwrite an Action."""
    workflow = Workflow.get_or_none(
        (Workflow.id == workflow_id) & (Workflow.deleted == 0)
    )
    if workflow is None:
        raise LookupError("流程不存在")
    payload = normalize_action_payload(payload)
    steps = json.loads(workflow.steps_json or "{}")
    buttons = steps.get("quickButtons", [])
    if not isinstance(buttons, list) or len(buttons) >= 20:
        raise ValueError("流程快捷按钮已满或配置无效")
    if any(isinstance(item, dict) and (
        item.get("id") == payload["id"] or item.get("action_id") == payload["action_id"]
    ) for item in buttons):
        raise FileExistsError("流程中已存在同名 Action")
    project_root = Path(project.path).resolve()
    action_root = project_root / ".workstep" / "artifacts" / workflow.id / "actions" / payload["action_id"]
    if not action_root.resolve().is_relative_to(project_root):
        raise ValueError("Action 目录超出项目根目录")
    action_root.mkdir(parents=True, exist_ok=False)
    script = action_root / payload["script_path"]
    try:
        script.write_text(payload["script_content"], encoding="utf-8")
        (action_root / "action.json").write_text(
            json.dumps({
                "id": payload["action_id"],
                "interpreter": "python" if script.suffix == ".py" else "bash",
                "timeout_seconds": 0,
                "managed_service": True,
            }, ensure_ascii=False),
            encoding="utf-8",
        )
        button = {key: value for key, value in payload.items() if key not in {"script_content", "workflow_id"}}
        steps["quickButtons"] = normalize_quick_buttons([*buttons, button])
        workflow.steps_json = json.dumps(steps, ensure_ascii=False)
        workflow.updated_at = utc_now()
        workflow.save(only=[Workflow.steps_json, Workflow.updated_at])
    except Exception:
        # The directory was created exclusively by this call.
        for filename in (payload["script_path"], "action.json"):
            child = action_root / filename
            if child.exists():
                child.unlink()
        action_root.rmdir()
        raise
    return {
        "workflow_id": workflow.id,
        "action_id": payload["action_id"],
        "script_path": str(script.relative_to(project_root)),
    }
