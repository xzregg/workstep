"""Validate and publish workflow-level Action shortcuts."""

import json
import os
import uuid
from contextlib import contextmanager
from pathlib import Path

from models import ProjectSetting, Workflow
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
        "confirmation_input_prompt": payload.get("confirmation_input_prompt") or "",
    }])[0]
    return {**button, "script_content": script_content, "overwrite": payload.get("overwrite") is True}


@contextmanager
def _published_action_files(project_root: Path, action_root: Path, payload: dict, *, replacing: bool = False):
    """Publish Action files and restore them if button persistence fails."""
    if not action_root.resolve().is_relative_to(project_root):
        raise ValueError("Action 目录超出项目根目录")
    if replacing:
        if not action_root.is_dir() or action_root.is_symlink():
            raise ValueError("现有 Action 目录无效")
    else:
        action_root.mkdir(parents=True, exist_ok=False)
    script = action_root / payload["script_path"]
    metadata = action_root / "action.json"
    original_script = None
    original_metadata = None
    write_started = False
    try:
        if script.is_symlink() or metadata.is_symlink():
            raise ValueError("Action 文件不能是符号链接")
        if replacing:
            original_script = script.read_bytes() if script.exists() else None
            original_metadata = metadata.read_bytes() if metadata.exists() else None
        contents = (
            (script, payload["script_content"].encode("utf-8")),
            (metadata, json.dumps({
                "id": payload["action_id"],
                "interpreter": "python" if script.suffix == ".py" else "bash",
                "timeout_seconds": 0,
                "managed_service": True,
            }, ensure_ascii=False).encode("utf-8")),
        )
        write_started = True
        for target, data in contents:
            if replacing:
                staged = action_root / f".{target.name}.{uuid.uuid4().hex}.tmp"
                try:
                    staged.write_bytes(data)
                    os.replace(staged, target)
                finally:
                    staged.unlink(missing_ok=True)
            else:
                target.write_bytes(data)
        yield script
    except Exception:
        if replacing and write_started:
            for target, original in ((script, original_script), (metadata, original_metadata)):
                if original is None:
                    target.unlink(missing_ok=True)
                else:
                    target.write_bytes(original)
        elif not replacing:
            script.unlink(missing_ok=True)
            metadata.unlink(missing_ok=True)
            action_root.rmdir()
        raise


def create_workflow_action(project, workflow_id: str, payload: dict) -> dict:
    """Run inside the project's database executor; replace only an explicitly matched Action."""
    workflow = Workflow.get_or_none(
        (Workflow.id == workflow_id) & (Workflow.deleted == 0)
    )
    if workflow is None:
        raise LookupError("流程不存在")
    payload = normalize_action_payload(payload)
    steps = json.loads(workflow.steps_json or "{}")
    buttons = steps.get("quickButtons", [])
    if not isinstance(buttons, list):
        raise ValueError("流程快捷按钮已满或配置无效")
    matches = [index for index, item in enumerate(buttons) if isinstance(item, dict) and (
        item.get("id") == payload["id"] or item.get("action_id") == payload["action_id"]
    )]
    replacing = bool(matches)
    if replacing and (not payload["overwrite"] or len(matches) != 1
                      or buttons[matches[0]].get("kind") != "action"
                      or buttons[matches[0]].get("id") != payload["id"]
                      or buttons[matches[0]].get("action_id") != payload["action_id"]):
        raise FileExistsError("流程中已存在同名 Action")
    if replacing and buttons[matches[0]].get("script_path") != payload["script_path"]:
        raise ValueError("覆盖 Action 时需沿用现有脚本文件名")
    if not replacing and len(buttons) >= 20:
        raise ValueError("流程快捷按钮已满或配置无效")
    project_root = Path(project.path).resolve()
    action_root = project_root / ".workstep" / "artifacts" / workflow.id / "actions" / payload["action_id"]
    with _published_action_files(project_root, action_root, payload, replacing=replacing) as script:
        button = {key: value for key, value in payload.items() if key not in {"script_content", "workflow_id", "overwrite"}}
        updated_buttons = list(buttons)
        if replacing:
            updated_buttons[matches[0]] = button
        else:
            updated_buttons.append(button)
        steps["quickButtons"] = normalize_quick_buttons(updated_buttons)
        workflow.steps_json = json.dumps(steps, ensure_ascii=False)
        workflow.updated_at = utc_now()
        workflow.save(only=[Workflow.steps_json, Workflow.updated_at])
        for cached in project.workflows:
            if cached["id"] == workflow.id:
                cached["steps"] = steps
                if cached.get("is_default"):
                    project.steps = steps
                break
    return {
        "workflow_id": workflow.id,
        "action_id": payload["action_id"],
        "script_path": str(script.relative_to(project_root)),
        "overwritten": replacing,
    }


def create_project_action(project, project_id: str, payload: dict) -> dict:
    """Publish a project Action without replacing existing quick buttons."""
    from agent_assistants.chat_session import DEFAULT_QUICK_BUTTONS

    payload = normalize_action_payload(payload)
    row = ProjectSetting.get_or_none(
        (ProjectSetting.project_id == project_id)
        & (ProjectSetting.key == "chat_quick_buttons")
    )
    buttons = json.loads(row.value_json) if row else [dict(item) for item in DEFAULT_QUICK_BUTTONS]
    if not isinstance(buttons, list) or len(buttons) >= 20:
        raise ValueError("项目快捷按钮已满或配置无效")
    if any(isinstance(item, dict) and (
        item.get("id") == payload["id"] or item.get("action_id") == payload["action_id"]
    ) for item in buttons):
        raise FileExistsError("项目中已存在同名 Action")
    project_root = Path(project.path).resolve()
    action_root = project_root / ".workstep" / "actions" / payload["action_id"]
    with _published_action_files(project_root, action_root, payload) as script:
        button = {key: value for key, value in payload.items() if key not in {"script_content", "overwrite"}}
        cleaned = normalize_quick_buttons([*buttons, button])
        now = utc_now()
        if row is None:
            ProjectSetting.create(
                id=str(uuid.uuid4()), project_id=project_id,
                key="chat_quick_buttons", value_json=json.dumps(cleaned, ensure_ascii=False),
                updated_at=now,
            )
        else:
            row.value_json = json.dumps(cleaned, ensure_ascii=False)
            row.updated_at = now
            row.save(only=[ProjectSetting.value_json, ProjectSetting.updated_at])
    return {
        "project_id": project_id,
        "action_id": payload["action_id"],
        "script_path": str(script.relative_to(project_root)),
    }
