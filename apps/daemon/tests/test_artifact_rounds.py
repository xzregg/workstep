"""Artifact round directory contracts."""

import json

from services.artifact_rounds import (
    iter_artifact_rounds,
    next_artifact_round,
    select_upstream_round,
    step_round_dir,
    write_round_manifest,
)
from services.artifacts import list_task_artifacts


def test_iter_artifact_rounds_treats_legacy_stage_root_as_round_one(tmp_path):
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
