"""Confirmation-gated task coordinator Action proposals and execution."""

import asyncio
import json
import uuid

from models import ActionProposal, ReviewRun, StepSupplement, Task, TaskStep
from models.fields import utc_now
from services.workflow_actions import create_workflow_action, normalize_action_payload

LEGACY_ACTION_TYPE_ALIASES = {
    "supplement_stage": "supplement_step",
    "rerun_from_stage": "rerun_from_step",
}
ALLOWED_ACTIONS = {
    "supplement_step",
    "rerun_from_step",
    "review_decision",
    "create_workflow_action",
}


def _canonical_action_type(value: str) -> str:
    """Expose Step terminology while accepting rows created by older versions."""
    return LEGACY_ACTION_TYPE_ALIASES.get(value, value)


class CoordinatorActionService:
    """Owns proposal creation, idempotent confirmation and Action execution."""

    def __init__(self, project_manager, workflow_runtime):
        self._project_manager = project_manager
        self._workflow_runtime = workflow_runtime
        self._operation_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self.executing_actions: set[str] = set()

    async def _run_db(self, project_id: str, operation):
        return await self._project_manager.run_db(
            project_id, lambda _project: operation()
        )

    async def confirm_action(
        self,
        project_id: str,
        task_id: str,
        proposal_id: str,
        idempotency_key: str,
        overwrite: bool = False,
    ) -> dict:
        if not idempotency_key.strip():
            raise ValueError("Idempotency-Key is required")
        lock = self._operation_locks.setdefault(
            (project_id, task_id),
            asyncio.Lock(),
        )
        async with lock:
            self.executing_actions.add(proposal_id)
            try:
                action = await self._run_db(
                    project_id,
                    lambda: self._begin_action_sync(
                        task_id, proposal_id, idempotency_key, overwrite
                    ),
                )
                if "completed" in action:
                    return action["completed"]
                proposal_type = action["type"]
                payload = action["payload"]

                try:
                    if proposal_type == "supplement_step":
                        result = await self._run_db(
                            project_id,
                            lambda: self._execute_supplement(
                                project_id, task_id, proposal_id, payload
                            ),
                        )
                    elif proposal_type == "review_decision":
                        result = await self._execute_review_decision(
                            project_id,
                            task_id,
                            action,
                            payload,
                        )
                    elif proposal_type == "rerun_from_step":
                        result = await self._execute_rerun_from_step(
                            project_id,
                            task_id,
                            proposal_id,
                            action,
                            payload,
                        )
                    elif proposal_type == "create_workflow_action":
                        result = await self._project_manager.run_db(
                            project_id,
                            lambda project: self._execute_create_workflow_action_sync(
                                project, task_id, payload
                            ),
                        )
                    else:
                        raise RuntimeError(f"Unsupported action: {proposal_type}")
                except Exception as exc:
                    await self._run_db(
                        project_id,
                        lambda: self._mark_action_failed_sync(
                            proposal_id, str(exc)
                        ),
                    )
                    raise

                return await self._run_db(
                    project_id,
                    lambda: self._complete_action_sync(proposal_id, result),
                )
            finally:
                self.executing_actions.discard(proposal_id)

    async def cancel_action(
        self,
        project_id: str,
        task_id: str,
        proposal_id: str,
    ) -> dict:
        return await self._run_db(
            project_id,
            lambda: self._cancel_action_sync(task_id, proposal_id),
        )

    @staticmethod
    def _normalize_input_rounds(
        value,
        target_step_key: str,
    ) -> dict[str, int]:
        if not isinstance(value, dict):
            return {}
        normalized: dict[str, int] = {}
        for raw_step, raw_round in value.items():
            step_key = str(raw_step).strip()
            if not step_key or step_key == target_step_key:
                continue
            try:
                round_number = int(raw_round)
            except (TypeError, ValueError):
                raise ValueError(f"非法产物轮次: {raw_step}={raw_round}")
            if round_number < 1:
                raise ValueError(f"非法产物轮次: {raw_step}={raw_round}")
            normalized[step_key] = round_number
        return normalized

    def create_proposal(self, task, turn, assistant, result):
        proposal_data = result.get("proposal")
        if not isinstance(proposal_data, dict):
            return None
        proposal_type = _canonical_action_type(str(proposal_data.get("type") or ""))
        if proposal_type not in ALLOWED_ACTIONS:
            return None
        target_step_key = (
            proposal_data.get("target_step_key")
            or result.get("target_step_key")
        )
        payload = proposal_data.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        step_keys = {
            row.step_key for row in TaskStep.select().where(TaskStep.task == task)
        }
        if proposal_type not in {"review_decision", "create_workflow_action"} and target_step_key not in step_keys:
            return None
        expected_review_run_id = None
        expected_step_run_id = None
        expected_workflow_run_id = task.active_workflow_run_id
        if proposal_type == "supplement_step":
            content = str(payload.get("content", "")).strip()
            if not content:
                return None
            payload = {"content": content}
        elif proposal_type == "rerun_from_step":
            content = str(payload.get("content", "")).strip()
            payload = {
                "reset_session": payload.get("reset_session") is True,
                "input_rounds": self._normalize_input_rounds(
                    payload.get("input_rounds"),
                    target_step_key or "",
                )
            }
            if content:
                payload["content"] = content
        elif proposal_type == "review_decision":
            review_id = str(payload.get("review_run_id", ""))
            decision = str(payload.get("decision", "")).replace("-", "_")
            if decision not in {"approve", "reject", "force_approve"}:
                return None
            review = ReviewRun.get_or_none(
                (ReviewRun.id == review_id) & (ReviewRun.task == task)
            )
            if review is None or review.decision:
                return None
            target_step_key = review.step_key
            expected_review_run_id = review.id
            expected_step_run_id = review.step_run_id
            expected_workflow_run_id = review.workflow_run_id
            payload = {
                "review_run_id": review.id,
                "decision": decision,
                "comment": payload.get("comment"),
            }
        elif proposal_type == "create_workflow_action":
            if not task.workflow_id:
                return None
            try:
                payload = self._normalize_workflow_action_payload(payload)
            except ValueError:
                return None
            payload["workflow_id"] = task.workflow_id
            target_step_key = None
        impact = {
            "target_step_key": target_step_key,
            "summary": self._impact_summary(proposal_type, target_step_key),
        }
        now = utc_now()
        return ActionProposal.create(
            id=str(uuid.uuid4()),
            task=task,
            source_turn=turn,
            source_message=assistant,
            type=proposal_type,
            target_step_key=target_step_key,
            payload_json=json.dumps(payload, ensure_ascii=False),
            impact_json=json.dumps(impact, ensure_ascii=False),
            expected_task_version=task.state_version,
            expected_workflow_run_id=expected_workflow_run_id,
            expected_step_run_id=expected_step_run_id,
            expected_review_run_id=expected_review_run_id,
            status="pending",
            created_at=now,
            updated_at=now,
        )

    @staticmethod
    def _normalize_workflow_action_payload(payload: dict) -> dict:
        return normalize_action_payload(payload)

    @staticmethod
    def _execute_create_workflow_action_sync(project, task_id: str, payload: dict) -> dict:
        task = Task.get_by_id(task_id)
        if not task.workflow_id:
            raise ValueError("任务没有关联流程")
        return create_workflow_action(project, task.workflow_id, payload)

    def _execute_supplement(self, project_id, task_id, proposal_id, payload):
        with self._project_manager.activate_project_by_id(project_id):
            proposal = ActionProposal.get_by_id(proposal_id)
            task = Task.get_by_id(task_id)
            content = str(payload.get("content", "")).strip()
            if not content:
                raise RuntimeError("Supplement content cannot be empty")
            supplement = StepSupplement.create(
                id=str(uuid.uuid4()),
                task=task,
                step_key=proposal.target_step_key,
                content=content,
                source_proposal=proposal,
                created_sequence=proposal.source_message.sequence or 0,
                created_at=utc_now(),
            )
            task.state_version += 1
            task.updated_at = utc_now()
            task.save()
            return {"supplement_id": supplement.id, "status": "saved"}

    async def _execute_rerun_from_step(
        self,
        project_id: str,
        task_id: str,
        proposal_id: str,
        action: dict,
        payload: dict,
    ) -> dict:
        target_step_key = action["target_step_key"] or ""
        content = str(payload.get("content", "")).strip()
        input_rounds = self._normalize_input_rounds(
            payload.get("input_rounds"),
            target_step_key,
        )
        supplement_id = None
        if content:
            supplement_id = await self._run_db(
                project_id,
                lambda: self._ensure_rerun_supplement_sync(
                    task_id,
                    proposal_id,
                    content,
                ),
            )
        handle = await self._workflow_runtime.restart_from_step(
            project_id,
            task_id,
            target_step_key,
            expected_run_id=action["expected_workflow_run_id"],
            step_followup=content or None,
            input_rounds=input_rounds or None,
            reset_session=payload.get("reset_session") is True,
        )
        return {
            "run_id": handle.id,
            "status": "started",
            "supplement_id": supplement_id,
        }

    @staticmethod
    def _ensure_rerun_supplement_sync(
        task_id: str,
        proposal_id: str,
        content: str,
    ) -> str:
        proposal = ActionProposal.get_by_id(proposal_id)
        existing = StepSupplement.get_or_none(
            StepSupplement.source_proposal == proposal
        )
        if existing is not None:
            return existing.id
        task = Task.get_by_id(task_id)
        supplement = StepSupplement.create(
            id=str(uuid.uuid4()),
            task=task,
            step_key=proposal.target_step_key,
            content=content,
            source_proposal=proposal,
            created_sequence=proposal.source_message.sequence or 0,
            created_at=utc_now(),
        )
        task.state_version += 1
        task.updated_at = utc_now()
        task.save()
        # The proposal itself caused this version change. Keep failed reruns
        # retryable while still expiring other proposals based on the old state.
        proposal.expected_task_version = task.state_version
        proposal.updated_at = task.updated_at
        proposal.save(
            only=[ActionProposal.expected_task_version, ActionProposal.updated_at]
        )
        return supplement.id

    def _begin_action_sync(self, task_id, proposal_id, idempotency_key, overwrite=False):
        proposal = ActionProposal.get_or_none(
            (ActionProposal.id == proposal_id)
            & (ActionProposal.task == task_id)
        )
        if proposal is None:
            raise ValueError("Action proposal not found")
        if proposal.status == "succeeded":
            if proposal.confirm_idempotency_key == idempotency_key:
                return {"completed": self.proposal_to_dict(proposal)}
            raise RuntimeError("Action proposal has already executed")
        proposal_type = _canonical_action_type(proposal.type)
        if overwrite and (proposal.status != "failed" or proposal_type != "create_workflow_action"):
            raise RuntimeError("Only a failed workflow Action proposal can be retried with overwrite")
        if proposal.status == "failed" and proposal_type in {"rerun_from_step", "create_workflow_action"}:
            proposal.status = "pending"
            proposal.error = None
        if proposal.status != "pending":
            raise RuntimeError(f"Action proposal is not pending: {proposal.status}")
        task = Task.get_by_id(task_id)
        if task.state_version != proposal.expected_task_version:
            proposal.status = "expired"
            proposal.error = "Task state changed after this proposal"
            proposal.updated_at = utc_now()
            proposal.save()
            raise RuntimeError(proposal.error)
        proposal.status = "executing"
        payload = json.loads(proposal.payload_json)
        if overwrite:
            payload["overwrite"] = True
            proposal.payload_json = json.dumps(payload, ensure_ascii=False)
        proposal.confirm_idempotency_key = idempotency_key
        proposal.confirmed_at = utc_now()
        proposal.updated_at = proposal.confirmed_at
        proposal.save()
        return {
            "type": proposal_type,
            "payload": payload,
            "target_step_key": proposal.target_step_key,
            "expected_workflow_run_id": proposal.expected_workflow_run_id,
        }

    @staticmethod
    def _mark_action_failed_sync(proposal_id, error):
        failed = ActionProposal.get_by_id(proposal_id)
        failed.status = "failed"
        failed.error = error
        failed.updated_at = utc_now()
        failed.save()

    def _complete_action_sync(self, proposal_id, result):
        completed = ActionProposal.get_by_id(proposal_id)
        completed.status = "succeeded"
        completed.result_json = json.dumps(result, ensure_ascii=False)
        completed.executed_at = utc_now()
        completed.updated_at = completed.executed_at
        completed.error = None
        completed.save()
        return self.proposal_to_dict(completed)

    def _cancel_action_sync(self, task_id, proposal_id):
        proposal = ActionProposal.get_or_none(
            (ActionProposal.id == proposal_id)
            & (ActionProposal.task == task_id)
        )
        if proposal is None:
            raise ValueError("Action proposal not found")
        if proposal.status != "pending":
            raise RuntimeError(f"Action proposal is not pending: {proposal.status}")
        proposal.status = "cancelled"
        proposal.updated_at = utc_now()
        proposal.save()
        return self.proposal_to_dict(proposal)

    async def _execute_review_decision(
        self,
        project_id,
        task_id,
        proposal,
        payload,
    ):
        handle = await self._workflow_runtime.decide_review(
            project_id,
            task_id,
            proposal["target_step_key"] or "",
            payload["review_run_id"],
            payload["decision"],
            payload.get("comment"),
        )
        return {
            "decision": payload["decision"],
            "resumed": handle is not None,
            "run_id": handle.id if handle else None,
        }

    def _impact_summary(self, proposal_type, step_key):
        if proposal_type == "create_workflow_action":
            return "确认后创建流程快捷 Action 脚本和按钮，不会立即执行"
        if proposal_type == "supplement_step":
            return f"Save context for future attempts of step '{step_key}'"
        if proposal_type == "review_decision":
            return f"Apply the review decision for step '{step_key}'"
        return f"Restart step '{step_key}' and its downstream steps"

    def proposal_to_dict(self, proposal: ActionProposal) -> dict:
        return {
            "id": proposal.id,
            "type": _canonical_action_type(proposal.type),
            "target_step_key": proposal.target_step_key,
            "payload": json.loads(proposal.payload_json),
            "impact": (
                json.loads(proposal.impact_json) if proposal.impact_json else None
            ),
            "status": proposal.status,
            "result": (
                json.loads(proposal.result_json) if proposal.result_json else None
            ),
            "error": proposal.error,
            "created_at": proposal.created_at,
            "updated_at": proposal.updated_at,
        }
