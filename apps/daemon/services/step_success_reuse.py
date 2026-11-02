"""Reuse an accepted step result without starting an engine or artifact round.

All functions in this module run inside the project database executor.
"""

import json
import uuid
from pathlib import Path

from models import ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from models.base import db_proxy
from models.fields import utc_now
from services.artifact_rounds import select_upstream_round
from services.artifact_routing import source_for_connection
from services.pipeline import Step


def preserved_success_keys(task: Task, steps: list[Step], targets: set[str]) -> set[str]:
    """Keep successful incidental downstream stages successful during rewinds."""
    enabled = {step.key for step in steps if step.reuse_success} - targets
    return {row.step_key for row in TaskStep.select().where(
        (TaskStep.task == task) & (TaskStep.step_key.in_(enabled))
        & (TaskStep.status == "passed")
    )} if enabled else set()


def reuse_successful_step(
    task: Task, step: Step, artifacts_dir: Path, workflow_run: WorkflowRun | None,
) -> int | None:
    if not step.reuse_success:
        return None
    row = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == step.key))
    # An unfinished direct execution/review must never be replaced by an older
    # success. Direct feedback targets use rework, incidental stages do not.
    if row.status not in {"pending", "passed", "rework_waiting"}:
        return None
    source = (StepRun.select().join(WorkflowRun).where(
        (WorkflowRun.task == task) & (StepRun.step_key == step.key)
    ).order_by(StepRun.started_at.desc(), StepRun.artifact_round.desc(), StepRun.attempt.desc()).first())
    if source is not None:
        if source.status not in {"succeeded", "reused"}:
            return None
        review = ReviewRun.select().where(ReviewRun.step_run == source).order_by(ReviewRun.attempt.desc()).first()
        if review is not None and review.status != "passed":
            return None
        if source.io_contract_json:
            contract = json.loads(source.io_contract_json)
            if contract.get("outputs") != step.outputs:
                raise ValueError("已有成功产物与当前输出配置不一致，请直接触发该步骤重新生成")
    elif row.status != "passed":
        return None
    selected = select_upstream_round(
        artifacts_dir, task.workflow_id, task.id, step.key,
        source.artifact_round if source is not None else None,
    )
    if selected is None:
        raise ValueError("已有成功产物缺失，请直接触发该步骤重新生成")
    if not selected.eligible_for_downstream:
        return None
    usable = False
    for port, output in enumerate(step.outputs):
        value = source_for_connection({"fromPort": port}, selected, output, allow_artifact_remap=True)
        if value is None:
            continue
        declared = next((item for item in selected.manifest.get("outputs", [])
                         if isinstance(item, dict) and item.get("port") == port), None)
        if value.get("name") != output.get("name") or (
            declared is not None and declared.get("type") != output.get("type")
        ):
            raise ValueError("已有成功产物与当前输出配置不一致，请直接触发该步骤重新生成")
        path = Path(value["path"])
        if path.is_symlink() or not path.resolve().is_relative_to(selected.path.resolve()):
            raise ValueError("已有成功产物路径不可用，请直接触发该步骤重新生成")
        nonempty = (
            path.is_file() and path.stat().st_size > 0
            or path.is_dir() and any(
                child.is_file() and not child.is_symlink() and child.stat().st_size > 0
                for child in path.rglob("*")
            )
        )
        if not nonempty:
            raise ValueError("已有成功产物缺失或为空，请直接触发该步骤重新生成")
        usable = True
    if not usable:
        raise ValueError("没有与当前输出配置匹配的成功产物，请直接触发该步骤重新生成")
    now = utc_now()
    with db_proxy.atomic():
        if workflow_run is not None:
            latest = StepRun.select().where(
                (StepRun.run == workflow_run) & (StepRun.step_key == step.key)
            ).order_by(StepRun.attempt.desc()).first()
            if latest is None or latest.status != "reused" or latest.artifact_round != selected.round:
                StepRun.create(
                    id=str(uuid.uuid4()), run=workflow_run, step_key=step.key,
                    attempt=latest.attempt + 1 if latest else 1, status="reused",
                    artifact_round=selected.round, source_step_run_id=source.id if source else None,
                    engine=source.engine if source else row.engine,
                    model=source.model if source else None,
                    io_contract_json=json.dumps({"inputs": step.inputs, "outputs": step.outputs}),
                    started_at=now, ended_at=now,
                )
        TaskStep.update(status="passed", error=None,
                        rework_feedback=None, review_feedback=None).where(
            (TaskStep.task == task) & (TaskStep.step_key == step.key)
        ).execute()
    return selected.round
