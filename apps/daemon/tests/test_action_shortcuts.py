"""Action shortcut configuration and execution boundaries."""

import pytest

from services.quick_buttons import normalize_quick_buttons
from services.workflow_definition import WorkflowDefinition, WorkflowValidationError


def test_workflow_quick_buttons_validate_and_preserve_local_scope():
    raw = {
        "nodes": [{"id": "node-1", "key": "build", "label": "构建", "quickButtons": [
            {"id": "restart", "kind": "action", "label": "重启服务", "action_id": "restart", "script_path": "restart.sh"},
        ]}],
        "connections": [],
        "inheritProjectQuickButtons": False,
    }
    WorkflowDefinition.load(raw).validate()
    bad = {**raw, "nodes": [{**raw["nodes"][0], "quickButtons": [
        {**raw["nodes"][0]["quickButtons"][0], "script_path": "../../escape.sh"},
    ]}]}
    with pytest.raises(WorkflowValidationError, match="脚本路径"):
        WorkflowDefinition.load(bad).validate()
    with pytest.raises(WorkflowValidationError, match="inheritProjectQuickButtons"):
        WorkflowDefinition.load({**raw, "inheritProjectQuickButtons": "false"}).validate()


def test_workflow_project_button_selection_requires_unique_ids():
    raw = {"nodes": [], "connections": [], "projectQuickButtonIds": ["restart", "docs"]}
    WorkflowDefinition.load(raw).validate()
    for invalid in (["restart", "restart"], ["restart", 3], "restart"):
        with pytest.raises(WorkflowValidationError, match="projectQuickButtonIds"):
            WorkflowDefinition.load({**raw, "projectQuickButtonIds": invalid}).validate()


def test_display_button_keeps_title_and_html_content():
    buttons = normalize_quick_buttons([{
        "id": "link", "kind": "display", "label": "开发地址",
        "content": '<a href="http://localhost:5173">打开前端</a>',
    }])
    assert buttons[0]["label"] == "开发地址"
    assert buttons[0]["content"] == '<a href="http://localhost:5173">打开前端</a>'
    assert buttons[0]["prompt"] == ""


def test_action_button_keeps_confirmation_input_prompt():
    buttons = normalize_quick_buttons([{
        "id": "commit", "kind": "action", "label": "提交并推送",
        "action_id": "commit", "script_path": "commit.sh",
        "confirmation_input_prompt": "请输入 Commit 消息",
    }])
    assert buttons[0]["confirmation_input_prompt"] == "请输入 Commit 消息"
    without_confirmation = normalize_quick_buttons([{
        **buttons[0], "require_confirmation": False,
    }])
    assert without_confirmation[0]["confirmation_input_prompt"] == "请输入 Commit 消息"
    with pytest.raises(ValueError, match="确认输入提示"):
        normalize_quick_buttons([{
            **buttons[0], "confirmation_input_prompt": "x" * 201,
        }])


def test_workflow_level_quick_buttons_are_validated():
    button = {"id": "restart", "kind": "action", "label": "重启", "action_id": "restart", "script_path": "restart.sh"}
    WorkflowDefinition.load({"nodes": [], "connections": [], "quickButtons": [button]}).validate()
    with pytest.raises(WorkflowValidationError, match="quickButtons"):
        WorkflowDefinition.load({"nodes": [], "connections": [], "quickButtons": [{**button, "script_path": "../escape.sh"}]}).validate()
