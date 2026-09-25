"""Synchronous project database work unit for starting one task step."""

import json
import uuid
from pathlib import Path
from typing import NamedTuple

from models import Message, StepRun, Task, TaskStep, WorkflowRun
from models.fields import utc_now
from services.artifact_rounds import next_artifact_round
from services.pipeline import Step


class StartedStepState(NamedTuple):
    task_step: TaskStep
    step_run: StepRun | None
    rework_feedback: str | None
    manual_review_feedback: str | None
    pending_handoff: dict | None
    artifact_round: int | None
    input_rounds: dict[str, int]
    previous_execution_prompt: str | None


def start_step_state(
    *, task: Task, step: Step, workflow_run: WorkflowRun | None,
    artifacts_dir: Path, effective_provider_id: str, resolved_model: str | None,
    input_rounds: dict[str, int], input_snapshot: dict,
) -> StartedStepState:
    """Persist startup state; call only through the project database executor."""
    step_key = step.key
    ts = TaskStep.get(
        (TaskStep.task == task) & (TaskStep.step_key == step_key)
    )
    previous_engine = ts.engine
    last_completed_execution = (
        Message.select()
        .where(
            (Message.task == task)
            & (Message.step_key == step_key)
            & (Message.channel == "execution")
            & (Message.role == "assistant")
            & (Message.run_status.in_(["succeeded", "completed"]))
        )
        .order_by(Message.sequence.desc())
        .first()
    )
    previous_execution_message = (
        Message.select()
        .where(
            (Message.task == task)
            & (Message.step_key == step_key)
            & (Message.channel == "execution")
            & (Message.role == "assistant")
        )
        .order_by(Message.sequence.desc())
        .first()
    )
    previous_execution_prompt = None
    if previous_execution_message is not None:
        try:
            previous_execution_prompt = json.loads(
                previous_execution_message.prompt_json or "{}"
            ).get("prompt")
        except (TypeError, json.JSONDecodeError):
            previous_execution_prompt = None
    session_engine = (
        last_completed_execution.engine
        if last_completed_execution is not None
        and last_completed_execution.engine
        else previous_engine
    )
    # Engine session identifiers are provider-specific: an engine or
    # provider switch must not resume the old session. The assembled
    # step prompt still carries supplements, upstream artifacts and
    # task context (plus the handoff reference when one is pending),
    # but the new endpoint must create its own session instead of
    # receiving an incompatible ID.
    session_provider = effective_provider_id
    if ts.session_id and (
        ts.pending_handoff_json
        or (session_engine and session_engine != step.engine)
        # 同引擎但供应商变更（含重置为默认后 provider 覆盖被移除）：
        # 旧会话建立于另一个供应商端点，不能继续 resume。
        or (
            session_engine == step.engine
            and str(ts.session_provider or "").strip() != session_provider
        )
    ):
        ts.session_id = None
    is_review_retry = (
        ts.status in ("retrying", "rework_waiting")
        and ts.started_at is not None
    )
    rework_feedback = ts.rework_feedback
    if rework_feedback:
        ts.rework_feedback = None
    manual_review_feedback = ts.review_feedback
    if manual_review_feedback:
        ts.review_feedback = None
    ts.status = "running"
    if not is_review_retry:
        ts.started_at = utc_now()
    ts.ended_at = None
    ts.engine = step.engine
    ts.save()

    step_run = None
    artifact_round = None
    if workflow_run is not None:
        attempt = (
            StepRun.select()
            .where(
                (StepRun.run == workflow_run)
                & (StepRun.step_key == step_key)
            )
            .count()
            + 1
        )
        latest_round_row = (
            StepRun.select(StepRun.artifact_round)
            .join(WorkflowRun)
            .where(
                (WorkflowRun.task == task)
                & (StepRun.step_key == step_key)
                & (StepRun.artifact_round.is_null(False))
                & (StepRun.status.in_(["succeeded", "reused"]))
            )
            .order_by(StepRun.artifact_round.desc())
            .first()
        )
        artifact_round = next_artifact_round(
            artifacts_dir,
            task.workflow_id,
            task.id,
            step_key,
            database_round=(
                latest_round_row.artifact_round
                if latest_round_row is not None else 0
            ),
        )
        step_run = StepRun.create(
            id=str(uuid.uuid4()),
            run=workflow_run,
            step_key=step_key,
            attempt=attempt,
            artifact_round=artifact_round,
            input_rounds_json=(
                json.dumps(input_rounds, ensure_ascii=False)
                if input_rounds else None
            ),
            input_snapshot_json=json.dumps(
                input_snapshot, ensure_ascii=False
            ),
            io_contract_json=json.dumps(
                {
                    "inputs": step.inputs,
                    "outputs": step.outputs,
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
            status="running",
            engine=step.engine,
            model=resolved_model,
            started_at=utc_now(),
        )

    # 步骤确实开始执行，任务与运行必须回到 running。中断的重复派发（例如
    # 另一个 daemon 实例的启动恢复）可能已把行写成 paused/failed，而真正
    # 在跑的这条流水线不会自己回写状态，前端就会在整轮重跑/重审期间一直
    # 显示「暂停」。条件 UPDATE 只修过期行，也不覆盖其它并发字段。
    Task.update(
        status="running",
        updated_at=utc_now(),
    ).where(
        (Task.id == task.id) & (Task.status != "running")
    ).execute()
    task.status = "running"
    if workflow_run is not None:
        WorkflowRun.update(
            status="running",
            ended_at=None,
        ).where(
            (WorkflowRun.id == workflow_run.id)
            & (
                (WorkflowRun.status != "running")
                | WorkflowRun.ended_at.is_null(False)
            )
        ).execute()
        workflow_run.status = "running"
        workflow_run.ended_at = None

    pending_handoff = None
    if ts.pending_handoff_json:
        try:
            value = json.loads(ts.pending_handoff_json)
            pending_handoff = value if isinstance(value, dict) else None
        except (TypeError, json.JSONDecodeError):
            pending_handoff = None
    return StartedStepState(
        ts,
        step_run,
        rework_feedback,
        manual_review_feedback,
        pending_handoff,
        artifact_round,
        input_rounds,
        previous_execution_prompt,
    )
