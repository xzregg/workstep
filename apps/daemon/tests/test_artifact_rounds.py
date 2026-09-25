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


def test_list_task_artifacts_exposes_declared_output_port(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    round_dir = step_round_dir(artifacts_root, "dev", "task-1", "build", 1)
    round_dir.mkdir(parents=True)
    (round_dir / "front.md").write_text("front", encoding="utf-8")
    (round_dir / "back.md").write_text("back", encoding="utf-8")
    write_round_manifest(
        artifacts_root=artifacts_root,
        workflow_id="dev",
        task_id="task-1",
        step_key="build",
        artifact_round=1,
        status="passed",
        eligible_for_downstream=True,
        outputs=[
            {"name": "front", "type": "md"},
            {"name": "back", "type": "md"},
        ],
    )

    artifacts = list_task_artifacts(
        type("Project", (), {"workstep_dir": str(tmp_path / ".workstep")})(),
        "task-1",
    )

    assert {item["logical_name"]: item["output_port"] for item in artifacts} == {
        "front": 0,
        "back": 1,
    }


def test_list_task_artifacts_marks_identical_content_across_rounds(tmp_path, monkeypatch):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    for round_number in (1, 2):
        round_dir = step_round_dir(artifacts_root, "dev", "task-1", "ui", round_number)
        round_dir.mkdir(parents=True)
        (round_dir / "design.md").write_text("沿用原设计", encoding="utf-8")
        write_round_manifest(
            artifacts_root=artifacts_root, workflow_id="dev", task_id="task-1",
            step_key="ui", artifact_round=round_number,
            status="passed", eligible_for_downstream=True,
        )

    project = type("Project", (), {"workstep_dir": str(tmp_path / ".workstep")})()
    from pathlib import Path

    original_open = Path.open

    def reject_artifact_read(path, mode="r", *args, **kwargs):
        if path.name == "design.md" and "b" in mode:
            raise AssertionError("listing must not read artifact contents")
        return original_open(path, mode, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "open", reject_artifact_read)
        artifacts = list_task_artifacts(project, "task-1")
    first, second = sorted(artifacts, key=lambda item: item["round"])
    assert first["unchanged_from_round"] is None
    assert second["unchanged_from_round"] == 1
    assert second["round_unchanged_from"] == 1

    # A same-size edit must not be mistaken for an unchanged artifact.
    (step_round_dir(artifacts_root, "dev", "task-1", "ui", 2) / "design.md").write_text(
        "重新做设计", encoding="utf-8",
    )
    with monkeypatch.context() as patch:
        patch.setattr(Path, "open", reject_artifact_read)
        second = next(item for item in list_task_artifacts(project, "task-1") if item["round"] == 2)
    assert second["unchanged_from_round"] is None
    assert second["round_unchanged_from"] is None


def test_manifest_streams_file_hashes_and_records_round_comparison(tmp_path, monkeypatch):
    from pathlib import Path

    artifacts_root = tmp_path / ".workstep" / "artifacts"
    original_read_bytes = Path.read_bytes

    def reject_whole_file_read(path):
        if path.name == "large.bin":
            raise AssertionError("manifest must stream large file contents")
        return original_read_bytes(path)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "read_bytes", reject_whole_file_read)
        for round_number in (1, 2):
            round_dir = step_round_dir(artifacts_root, "dev", "task-1", "ui", round_number)
            round_dir.mkdir(parents=True)
            (round_dir / "large.bin").write_bytes(b"same content")
            manifest = write_round_manifest(
                artifacts_root=artifacts_root, workflow_id="dev", task_id="task-1",
                step_key="ui", artifact_round=round_number,
                status="passed", eligible_for_downstream=True,
            )
    assert manifest["content_comparison"] == {
        "previous_round": 1,
        "round_unchanged": True,
        "unchanged_paths": ["large.bin"],
    }


def test_manifest_does_not_mark_same_size_different_content_as_unchanged(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    for round_number, content in ((1, b"abcd"), (2, b"wxyz")):
        round_dir = step_round_dir(artifacts_root, "dev", "task-1", "ui", round_number)
        round_dir.mkdir(parents=True)
        (round_dir / "design.bin").write_bytes(content)
        manifest = write_round_manifest(
            artifacts_root=artifacts_root, workflow_id="dev", task_id="task-1",
            step_key="ui", artifact_round=round_number,
            status="passed", eligible_for_downstream=True,
        )
    assert manifest["content_comparison"] == {
        "previous_round": 1,
        "round_unchanged": False,
        "unchanged_paths": [],
    }


def test_new_round_does_not_guess_equality_against_legacy_manifest(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    old_dir = step_round_dir(artifacts_root, "dev", "task-1", "ui", 1)
    old_dir.mkdir(parents=True)
    (old_dir / "design.md").write_text("same", encoding="utf-8")
    (old_dir / "manifest.json").write_text(json.dumps({
        "artifacts": [{"path": "design.md", "name": "design.md"}],
        "eligible_for_downstream": True,
    }), encoding="utf-8")
    new_dir = step_round_dir(artifacts_root, "dev", "task-1", "ui", 2)
    new_dir.mkdir(parents=True)
    (new_dir / "design.md").write_text("same", encoding="utf-8")
    manifest = write_round_manifest(
        artifacts_root=artifacts_root, workflow_id="dev", task_id="task-1",
        step_key="ui", artifact_round=2,
        status="passed", eligible_for_downstream=True,
    )
    assert manifest["content_comparison"] is None
    project = type("Project", (), {"workstep_dir": str(tmp_path / ".workstep")})()
    newest = next(item for item in list_task_artifacts(project, "task-1") if item["round"] == 2)
    assert newest["unchanged_from_round"] is None
    assert newest["round_unchanged_from"] is None


def test_list_task_artifacts_distinguishes_file_and_whole_round_changes(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    for round_number in (1, 2):
        round_dir = step_round_dir(artifacts_root, "dev", "task-1", "ui", round_number)
        (round_dir / "assets").mkdir(parents=True)
        (round_dir / "assets" / "icon.svg").write_text("same", encoding="utf-8")
        (round_dir / "spec.md").write_text("same", encoding="utf-8")
        write_round_manifest(
            artifacts_root=artifacts_root, workflow_id="dev", task_id="task-1",
            step_key="ui", artifact_round=round_number,
            status="passed", eligible_for_downstream=True,
            outputs=[{"name": "assets", "type": "directory"}],
        )
    (step_round_dir(artifacts_root, "dev", "task-1", "ui", 2) / "assets" / "icon.svg").write_text(
        "diff", encoding="utf-8",
    )
    project = type("Project", (), {"workstep_dir": str(tmp_path / ".workstep")})()
    second = [item for item in list_task_artifacts(project, "task-1") if item["round"] == 2]
    assert all(item["round_unchanged_from"] is None for item in second)
    assert next(item for item in second if item["name"] == "spec.md")["unchanged_from_round"] == 1
    assert next(item for item in second if item["name"] == "assets")["unchanged_from_round"] is None


def test_list_task_artifacts_does_not_mark_round_unchanged_after_file_removal(tmp_path):
    artifacts_root = tmp_path / ".workstep" / "artifacts"
    for round_number in (1, 2):
        round_dir = step_round_dir(artifacts_root, "dev", "task-1", "ui", round_number)
        round_dir.mkdir(parents=True)
        (round_dir / "kept.md").write_text("same", encoding="utf-8")
        if round_number == 1:
            (round_dir / "removed.md").write_text("old", encoding="utf-8")
        write_round_manifest(
            artifacts_root=artifacts_root, workflow_id="dev", task_id="task-1",
            step_key="ui", artifact_round=round_number,
            status="passed", eligible_for_downstream=True,
        )
    project = type("Project", (), {"workstep_dir": str(tmp_path / ".workstep")})()
    kept = next(item for item in list_task_artifacts(project, "task-1") if item["round"] == 2)
    assert kept["unchanged_from_round"] == 1
    assert kept["round_unchanged_from"] is None


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
