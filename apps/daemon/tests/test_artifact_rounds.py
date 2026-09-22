"""Artifact round directory contracts."""

from datetime import datetime
import json

from services.artifact_rounds import (
    active_output_ports,
    iter_artifact_rounds,
    next_artifact_round,
    select_upstream_round,
    step_round_dir,
    write_round_manifest,
)


def test_manifest_marks_only_nonempty_declared_outputs_active(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    round_dir = step_round_dir(artifacts_root, "dev", "task-1", "test", 1)
    round_dir.mkdir(parents=True)
    (round_dir / "测试报告.md").write_text("测试通过", encoding="utf-8")
    (round_dir / "Bug列表.md").write_bytes(b"")

    manifest = write_round_manifest(
        artifacts_root=artifacts_root,
        workflow_id="dev",
        task_id="task-1",
        step_key="test",
        artifact_round=1,
        status="passed",
        eligible_for_downstream=True,
        outputs=[
            {"name": "测试报告", "type": "md"},
            {"name": "Bug列表", "type": "md"},
            {"name": "诊断附件", "type": "json"},
        ],
    )

    assert manifest["outputs"] == [
        {
            "port": 0,
            "name": "测试报告",
            "type": "md",
            "path": "测试报告.md",
            "exists": True,
            "size": len("测试通过".encode("utf-8")),
            "nonempty": True,
        },
        {
            "port": 1,
            "name": "Bug列表",
            "type": "md",
            "path": "Bug列表.md",
            "exists": True,
            "size": 0,
            "nonempty": False,
        },
        {
            "port": 2,
            "name": "诊断附件",
            "type": "json",
            "path": "诊断附件.json",
            "exists": False,
            "size": 0,
            "nonempty": False,
        },
    ]
    assert active_output_ports(manifest) == {0}


def test_directory_output_requires_a_nonhidden_nonempty_file(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    round_dir = step_round_dir(artifacts_root, "dev", "task-1", "design", 1)

    hidden_only = round_dir / "隐藏占位目录"
    hidden_only.mkdir(parents=True)
    (hidden_only / ".gitkeep").write_text("placeholder", encoding="utf-8")
    (hidden_only / ".cache").mkdir()
    (hidden_only / ".cache" / "result.md").write_text("hidden", encoding="utf-8")
    (hidden_only / "empty.md").write_bytes(b"")

    produced = round_dir / "有效目录"
    (produced / "nested").mkdir(parents=True)
    (produced / "nested" / "result.md").write_text("result", encoding="utf-8")
    (produced / ".DS_Store").write_text("metadata", encoding="utf-8")

    manifest = write_round_manifest(
        artifacts_root=artifacts_root,
        workflow_id="dev",
        task_id="task-1",
        step_key="design",
        artifact_round=1,
        status="passed",
        eligible_for_downstream=True,
        outputs=[
            {"name": "隐藏占位目录", "type": "directory"},
            {"name": "有效目录", "type": "directory"},
        ],
    )

    assert manifest["outputs"][0]["exists"] is True
    assert manifest["outputs"][0]["size"] == 0
    assert manifest["outputs"][0]["nonempty"] is False
    assert manifest["outputs"][1]["size"] == len(b"result")
    assert manifest["outputs"][1]["nonempty"] is True
    assert active_output_ports(manifest) == {1}
from services.artifacts import list_task_artifacts


def test_iter_artifact_rounds_treats_legacy_step_root_as_round_one(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    legacy = artifacts_root / "dev" / "task-1" / "req"
    legacy.mkdir(parents=True)
    (legacy / "prd.md").write_text("# PRD")
    (legacy / "manifest.json").write_text(json.dumps({
        "artifacts": [{"name": "PRD", "type": "Markdown", "path": "prd.md"}],
    }))

    rounds = iter_artifact_rounds(artifacts_root, "dev", "task-1", "req")

    assert [(item.round, item.legacy, item.path) for item in rounds] == [
        (1, True, legacy),
    ]
    assert rounds[0].eligible_for_downstream is True


def test_next_artifact_round_uses_database_history_and_disk_history(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    (artifacts_root / "dev" / "task-1" / "req" / "2").mkdir(parents=True)
    assert next_artifact_round(
        artifacts_root, "dev", "task-1", "req", database_round=4
    ) == 5


def test_select_upstream_round_defaults_to_latest_eligible(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    write_round_manifest(
        artifacts_root=artifacts_root,
        workflow_id="dev",
        task_id="task-1",
        step_key="req",
        artifact_round=1,
        status="succeeded",
        eligible_for_downstream=True,
    )
    write_round_manifest(
        artifacts_root=artifacts_root,
        workflow_id="dev",
        task_id="task-1",
        step_key="req",
        artifact_round=2,
        status="failed",
        eligible_for_downstream=False,
    )

    selected = select_upstream_round(artifacts_root, "dev", "task-1", "req")

    assert selected is not None
    assert selected.round == 1


def test_list_task_artifacts_marks_only_latest_eligible_round_selected(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    for round_number in (1, 2):
        write_round_manifest(
            artifacts_root=artifacts_root,
            workflow_id="dev",
            task_id="task-1",
            step_key="req",
            artifact_round=round_number,
            status="passed",
            eligible_for_downstream=True,
        )
        (step_round_dir(
            artifacts_root, "dev", "task-1", "req", round_number
        ) / "prd.md").write_text(f"round {round_number}", encoding="utf-8")

    artifacts = list_task_artifacts(
        type("Project", (), {"workstep_dir": str(tmp_path / ".workstep")})(),
        "task-1",
    )

    selected = [item for item in artifacts if item["is_selected"]]
    assert [item["round"] for item in selected] == [2]
    assert [item["eligible_for_downstream"] for item in artifacts] == [True, True]
    datetime.fromisoformat(artifacts[0]["updated_at"])
    assert artifacts[0]["updated_at"].endswith("+00:00")


def test_select_upstream_round_honours_explicit_round(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    for round_number in (1, 2):
        (step_round_dir(
            artifacts_root, "dev", "task-1", "req", round_number
        )).mkdir(parents=True)
        write_round_manifest(
            artifacts_root=artifacts_root,
            workflow_id="dev",
            task_id="task-1",
            step_key="req",
            artifact_round=round_number,
            status="succeeded",
            eligible_for_downstream=True,
        )

    selected = select_upstream_round(artifacts_root, "dev", "task-1", "req", 1)

    assert selected is not None
    assert selected.round == 1
