"""Behavior tests for the workflow definition compiler."""

import contextlib
import json
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from services.workflow_definition import WorkflowDefinition, WorkflowValidationError


def test_legacy_steps_compile_to_task_runner_config():
    raw = {
        "steps": [
            {
                "key": "requirements",
                "label": "Requirements",
                "engine": "claude",
                "model": "sonnet",
                "config": {},
                "prompt": "Write the requirements",
                "color": "#123456",
                "inputs": [{"name": "brief", "type": "document"}],
                "outputs": [{"name": "prd", "type": "markdown"}],
                "dependsOn": [],
                "condition": "",
            },
            {
                "key": "build",
                "label": "Build",
                "engine": "codex",
                "prompt": "Build it",
                "dependsOn": ["requirements"],
            },
        ]
    }

    compiled = WorkflowDefinition.load(raw).compile()

    assert compiled.to_steps_config() == {
        "steps": [
            {
                "key": "requirements",
                "label": "Requirements",
                "engine": "claude",
                "model": "sonnet",
                "config": {},
                "prompt": "Write the requirements",
                "color": "#123456",
                "inputs": [{"name": "brief", "type": "document"}],
                "outputs": [{"name": "prd", "type": "markdown"}],
                "dependsOn": [],
                "condition": "",
                "reworkUpstream": [],
            },
            {
                "key": "build",
                "label": "Build",
                "engine": "codex",
                "model": "",
                "config": {},
                "prompt": "Build it",
                "color": "#888",
                "inputs": [],
                "outputs": [],
                "dependsOn": ["requirements"],
                "condition": "",
                "reworkUpstream": [],
            },
        ]
    }


def test_canvas_connections_compile_to_dependencies():
    raw = {
        "nodes": [
            {"id": 10, "type": "plan", "title": "Plan", "prompt": "Plan it"},
            {"id": 20, "type": "frontend", "title": "Frontend"},
            {"id": 30, "type": "backend", "title": "Backend"},
            {"id": 40, "type": "verify", "title": "Verify"},
        ],
        "connections": [
            {"from": 10, "fromPort": 0, "to": 20, "toPort": 0},
            {"from": 10, "fromPort": 0, "to": 30, "toPort": 0},
            {"from": 20, "fromPort": 0, "to": 40, "toPort": 0},
            {"from": 30, "fromPort": 0, "to": 40, "toPort": 0},
        ],
    }

    steps = WorkflowDefinition.load(raw).compile().to_steps_config()["steps"]

    assert [step["key"] for step in steps] == [
        "plan",
        "frontend",
        "backend",
        "verify",
    ]
    assert [step["dependsOn"] for step in steps] == [
        [],
        ["plan"],
        ["plan"],
        ["frontend", "backend"],
    ]
    assert steps[0]["label"] == "Plan"
    assert steps[0]["prompt"] == "Plan it"


def test_auto_start_uses_the_stage_selected_for_task_creation():
    workflow = WorkflowDefinition.load({
        "nodes": [
            {"id": 1, "type": "plan", "autoStart": False},
            {"id": 2, "type": "build", "autoStart": True},
        ],
        "connections": [],
    })

    assert workflow.auto_start_enabled() is False
    assert workflow.auto_start_enabled("plan") is False
    assert workflow.auto_start_enabled("build") is True


def test_duplicate_step_keys_are_rejected_with_the_node_location():
    raw = {
        "nodes": [
            {"id": 1, "type": "build", "title": "Build one"},
            {"id": 2, "key": "build", "title": "Build two"},
        ],
        "connections": [],
    }

    with pytest.raises(
        WorkflowValidationError,
        match=r"nodes\[1\]\.key: duplicate step key 'build'",
    ):
        WorkflowDefinition.load(raw).validate()


@pytest.mark.parametrize("key", ["", "front end", "1build", "需求"])
def test_invalid_step_keys_are_rejected_with_the_node_location(key):
    raw = {
        "nodes": [{"id": 1, "type": key, "title": "Build"}],
        "connections": [],
    }

    with pytest.raises(
        WorkflowValidationError,
        match=r"nodes\[0\]\.key: invalid step key",
    ):
        WorkflowDefinition.load(raw).validate()


def test_connection_to_missing_canvas_node_is_rejected_with_connection_location():
    raw = {
        "nodes": [{"id": 1, "type": "plan", "title": "Plan"}],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 99, "toPort": 0},
        ],
    }

    with pytest.raises(
        WorkflowValidationError,
        match=r"connections\[0\]\.to: node '99' does not exist",
    ):
        WorkflowDefinition.load(raw).compile()


def test_legacy_dependency_on_missing_step_is_rejected_with_dependency_location():
    raw = {
        "steps": [
            {
                "key": "build",
                "label": "Build",
                "dependsOn": ["requirements"],
            }
        ]
    }

    with pytest.raises(
        WorkflowValidationError,
        match=r"steps\[0\]\.dependsOn\[0\]: step 'requirements' does not exist",
    ):
        WorkflowDefinition.load(raw).compile()


def test_canvas_cycle_is_rejected_with_the_cycle_path():
    raw = {
        "nodes": [
            {"id": 1, "type": "plan", "title": "Plan"},
            {"id": 2, "type": "build", "title": "Build"},
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {"from": 2, "fromPort": 0, "to": 1, "toPort": 0},
        ],
    }

    with pytest.raises(
        WorkflowValidationError,
        match=r"workflow: cycle detected: plan -> build -> plan",
    ):
        WorkflowDefinition.load(raw).validate()


def test_multiple_port_connections_between_nodes_create_one_dependency():
    raw = {
        "nodes": [
            {
                "id": 1,
                "type": "design",
                "title": "Design",
                "outputs": [{"name": "ui"}, {"name": "spec"}],
            },
            {
                "id": 2,
                "type": "build",
                "title": "Build",
                "inputs": [{"name": "ui"}, {"name": "spec"}],
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {"from": 1, "fromPort": 1, "to": 2, "toPort": 1},
        ],
    }

    steps = WorkflowDefinition.load(raw).compile().to_steps_config()["steps"]

    assert steps[1]["dependsOn"] == ["design"]


def test_dashed_feedback_edge_is_excluded_from_dependencies_and_cycles():
    """A dashed (rework feedback) edge must not gate readiness nor form a cycle."""
    raw = {
        "nodes": [
            {"id": 1, "type": "frontend", "title": "前端"},
            {"id": 2, "type": "test", "title": "测试"},
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {"from": 2, "fromPort": 0, "to": 1, "toPort": 0, "kind": "dashed"},
        ],
    }

    compiled = WorkflowDefinition.load(raw).compile().to_steps_config()["steps"]
    steps = {s["key"]: s for s in compiled}
    assert steps["test"]["dependsOn"] == ["frontend"]
    assert steps["frontend"]["dependsOn"] == []
    assert steps["test"]["reworkUpstream"] == ["frontend"]


def test_dashed_edge_must_target_an_upstream_producer():
    """A dashed edge pointing downstream (not an upstream producer) is rejected."""
    raw = {
        "nodes": [
            {"id": 1, "type": "frontend", "title": "前端"},
            {"id": 2, "type": "test", "title": "测试"},
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0, "kind": "dashed"},
        ],
    }

    with pytest.raises(
        WorkflowValidationError,
        match=r"dashed edge 'frontend -> test' must target an upstream producer",
    ):
        WorkflowDefinition.load(raw).validate()


def test_dashed_self_edge_is_rejected():
    raw = {
        "nodes": [{"id": 1, "type": "test", "title": "测试"}],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 1, "toPort": 0, "kind": "dashed"},
        ],
    }

    with pytest.raises(
        WorkflowValidationError,
        match=r"dashed feedback edge 'test' cannot target itself",
    ):
        WorkflowDefinition.load(raw).validate()


def test_invalid_connection_kind_is_rejected():
    raw = {
        "nodes": [
            {"id": 1, "type": "a", "title": "A"},
            {"id": 2, "type": "b", "title": "B"},
        ],
        "connections": [{"from": 1, "to": 2, "kind": "dotted"}],
    }

    with pytest.raises(
        WorkflowValidationError,
        match=r"connections\[0\]\.kind: invalid value 'dotted'",
    ):
        WorkflowDefinition.load(raw).validate()


def test_steps_format_rejects_rework_upstream_missing_target():
    raw = {
        "steps": [
            {"key": "test", "label": "Test", "reworkUpstream": ["frontend"]},
        ]
    }

    with pytest.raises(
        WorkflowValidationError,
        match=r"steps\[0\]\.reworkUpstream\[0\]: step 'frontend' does not exist",
    ):
        WorkflowDefinition.load(raw).validate()


def test_steps_format_compiles_rework_upstream():
    raw = {
        "steps": [
            {"key": "frontend", "label": "Frontend"},
            {
                "key": "test",
                "label": "Test",
                "dependsOn": ["frontend"],
                "reworkUpstream": ["frontend"],
            },
        ]
    }

    compiled = WorkflowDefinition.load(raw).compile().to_steps_config()["steps"]
    steps = {s["key"]: s for s in compiled}
    assert steps["test"]["reworkUpstream"] == ["frontend"]


def test_connection_to_nonexistent_canvas_port_is_rejected():
    raw = {
        "nodes": [
            {
                "id": 1,
                "type": "design",
                "title": "Design",
                "outputs": [{"name": "ui"}],
            },
            {
                "id": 2,
                "type": "build",
                "title": "Build",
                "inputs": [{"name": "ui"}],
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 1, "to": 2, "toPort": 0},
        ],
    }

    with pytest.raises(
        WorkflowValidationError,
        match=r"connections\[0\]\.fromPort: port 1 does not exist on node '1'",
    ):
        WorkflowDefinition.load(raw).validate()


def test_compilation_migrates_unversioned_definitions_to_schema_version_one():
    compiled = WorkflowDefinition.load({"nodes": [], "connections": []}).compile()

    assert WorkflowDefinition.CURRENT_SCHEMA_VERSION == 1
    assert compiled.schema_version == 1


def test_future_schema_version_is_rejected():
    raw = {"schemaVersion": 2, "nodes": [], "connections": []}

    with pytest.raises(
        WorkflowValidationError,
        match=r"schemaVersion: unsupported version 2; expected 1",
    ):
        WorkflowDefinition.load(raw).compile()


@pytest.mark.anyio
async def test_project_rejects_an_invalid_workflow_before_saving(
    tmp_path,
    monkeypatch,
):
    """Invalid canvas definitions never replace the project's saved workflow."""
    import api.project as project_api
    from main import app

    workstep_dir = tmp_path / ".workstep"
    workstep_dir.mkdir()
    original = {"nodes": [], "connections": []}
    project = SimpleNamespace(
        id="project-1",
        workstep_dir=workstep_dir,
        steps=original,
    )

    class ProjectManagerStub:
        def get_project_by_id(self, project_id):
            return project if project_id == project.id else None

        def activate_project_by_id(self, project_id):
            proj = self.get_project_by_id(project_id)
            if not proj:
                raise ValueError(f"Project not found: {project_id}")
            return contextlib.nullcontext(proj)

        def update_workflow(self, proj, workflow_id, steps):
            proj.steps = steps
            return {"id": workflow_id}

    project.default_workflow = lambda: {"id": "default-wf", "steps": project.steps}

    monkeypatch.setattr(project_api, "project_manager", ProjectManagerStub())
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/project/save-steps?project_id=project-1",
            json={
                "steps": {
                    "nodes": [
                        {"id": 1, "type": "same"},
                        {"id": 2, "type": "same"},
                    ],
                    "connections": [],
                }
            },
        )

    assert response.status_code == 422
    assert "duplicate step key" in response.json()["detail"]
    assert project.steps is original


@pytest.mark.anyio
async def test_saved_workflow_becomes_the_project_runtime_definition(
    tmp_path,
    monkeypatch,
):
    """A successful canvas save is visible to the next run without a restart."""
    import api.project as project_api
    from main import app

    workstep_dir = tmp_path / ".workstep"
    workstep_dir.mkdir()
    project = SimpleNamespace(
        id="project-1",
        workstep_dir=workstep_dir,
        steps={"nodes": [], "connections": []},
    )
    saved = {
        "nodes": [
            {"id": 1, "type": "plan", "title": "Plan"},
            {"id": 2, "type": "build", "title": "Build"},
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
        ],
    }

    class ProjectManagerStub:
        def get_project_by_id(self, project_id):
            return project if project_id == project.id else None

        def activate_project_by_id(self, project_id):
            proj = self.get_project_by_id(project_id)
            if not proj:
                raise ValueError(f"Project not found: {project_id}")
            return contextlib.nullcontext(proj)

        def update_workflow(self, proj, workflow_id, steps):
            proj.steps = steps
            return {"id": workflow_id}

    project.default_workflow = lambda: {"id": "default-wf", "steps": project.steps}

    monkeypatch.setattr(project_api, "project_manager", ProjectManagerStub())
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/project/save-steps?project_id=project-1",
            json={"steps": saved},
        )

    assert response.status_code == 200
    assert project.steps == saved


def test_stage_config_passthrough_and_defaults():
    """阶段级 engine config 透传，缺省为 {}。"""
    raw = {
        "steps": [
            {"key": "a", "label": "A", "config": {"sandbox_mode": "read-only"}},
            {"key": "b", "label": "B"},
        ]
    }

    compiled = WorkflowDefinition.load(raw).compile().to_steps_config()["steps"]
    steps = {s["key"]: s for s in compiled}
    assert steps["a"]["config"] == {"sandbox_mode": "read-only"}
    assert steps["b"]["config"] == {}


def test_stage_config_rejects_non_dict():
    raw = {"steps": [{"key": "a", "label": "A", "config": "read-only"}]}

    with pytest.raises(WorkflowValidationError, match="expected a dict"):
        WorkflowDefinition.load(raw).compile()


def test_review_config_passthrough_and_defaults():
    """评审块同样支持阶段级 config，缺省为 {}。"""
    raw = {
        "steps": [{
            "key": "a",
            "label": "A",
            "review": {
                "mode": "auto",
                "auto": True,
                "maxRetries": 1,
                "engine": "codex",
                "model": "",
                "prompt": "",
                "config": {"approval_policy": "never"},
            },
        }]
    }

    compiled = WorkflowDefinition.load(raw).compile().to_steps_config()["steps"]
    steps = {s["key"]: s for s in compiled}
    assert steps["a"]["review"]["config"] == {"approval_policy": "never"}


def test_review_config_rejects_non_dict():
    raw = {
        "steps": [{
            "key": "a",
            "label": "A",
            "review": {"mode": "auto", "auto": True, "maxRetries": 1, "config": "never"},
        }]
    }

    with pytest.raises(WorkflowValidationError, match="expected a dict"):
        WorkflowDefinition.load(raw).compile()
