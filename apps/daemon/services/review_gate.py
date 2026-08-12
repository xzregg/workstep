"""Stage review gate: automatic agent review and persisted manual decisions."""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from engines.core.registry import create_engine
from models import ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from models.fields import utc_now
from services.config import config_store
from services.pipeline import Step


Publish = Callable[[dict], Awaitable[None]]


@dataclass(frozen=True)
class ReviewOutcome:
    status: str  # passed / rejected / awaiting_review
    review_run: ReviewRun
    report: dict
    events: tuple[dict, ...] = ()

    @property
    def feedback(self) -> str:
        summary = str(self.report.get("summary", "")).strip()
        issues = self.report.get("issues", [])
        lines = [summary] if summary else []
        for issue in issues:
            description = str(issue.get("description", "")).strip()
            suggestion = str(issue.get("suggestion", "")).strip()
            if description:
                lines.append(
                    f"- {description}" + (f"；建议：{suggestion}" if suggestion else "")
                )
        return "\n".join(lines)


class ReviewGate:
    """Hide review execution, parsing and persistence behind one interface."""

    def __init__(self, publish: Publish):
        self._publish = publish

    async def evaluate(
        self,
        *,
        task: Task,
        step: Step,
        workflow_run: WorkflowRun,
        step_run: StepRun,
        artifacts_dir: Path,
        execution_output: str,
        review_config: dict | None = None,
        mode: str | None = None,
    ) -> ReviewOutcome:
        config = dict(review_config) if review_config is not None else dict(step.review or {})
        if mode is None:
            mode = (
                "auto"
                if config.get("mode") == "auto" or config.get("auto", False)
                else "manual"
            )
        engine_id = str(config.get("engine") or step.engine)
        model = str(
            config.get("model")
            or step.model
            or config_store.get_engine_default_model(engine_id)
            or ""
        )
        prompt = self._assemble_prompt(
            task, step, artifacts_dir, execution_output, str(config.get("prompt", ""))
        )
        now = utc_now()
        # 同一 step_run 下可能先后有自动审核与转人工审核等多条记录，
        # attempt 按已有记录递增，避免 (step_run, attempt) 唯一约束冲突。
        existing_attempts = [
            review.attempt
            for review in ReviewRun.select().where(ReviewRun.step_run == step_run)
        ]
        attempt = max(existing_attempts, default=0) + 1
        review_run = ReviewRun.create(
            id=str(uuid.uuid4()),
            workflow_run=workflow_run,
            step_run=step_run,
            task=task,
            step_key=step.key,
            attempt=attempt,
            mode=mode,
            status="pending" if mode == "manual" else "running",
            engine=engine_id if mode == "auto" else None,
            model=model if mode == "auto" else None,
            prompt_json=json.dumps({"prompt": prompt}, ensure_ascii=False),
            started_at=now,
        )

        if mode == "manual":
            report = {
                "passed": False,
                "score": None,
                "summary": "阶段执行完成，等待用户审核。",
                "issues": [],
            }
            review_run.report_json = json.dumps(report, ensure_ascii=False)
            # 人工审核没有运行任何引擎：不保留提示词，前端不显示「查看提示词」。
            review_run.prompt_json = None
            review_run.status = "pending"
            review_run.save()
            await self._emit(task, step, step_run, review_run, "awaiting_review", report)
            return ReviewOutcome("awaiting_review", review_run, report)

        await self._emit(task, step, step_run, review_run, "reviewing")
        engine = create_engine(engine_id)
        ts = TaskStep.get_or_none(
            (TaskStep.task == task) & (TaskStep.step_key == step.key)
        )
        review_session_id = ts.review_session_id if ts is not None else None
        response_parts: list[str] = []
        events_collected: list[dict] = []
        error: str | None = None
        if not engine:
            error = f"Review engine '{engine_id}' not available"
        else:
            try:
                async for event in engine.spawn(
                    prompt=prompt,
                    cwd=task.cwd,
                    model=model or None,
                    session_id=(
                        review_session_id if engine.supports_resume else None
                    ),
                    config_overrides=(
                        config.get("config")
                        or step.config
                        or None
                    ),
                ):
                    normalize_event = getattr(engine, "normalize_event", None)
                    if normalize_event is not None:
                        event = normalize_event(event)
                    if event is None:
                        continue
                    events_collected.append(event.to_dict())
                    if event.type == "text_delta":
                        response_parts.append(str(event.data.get("delta", "")))
                    elif event.type == "error" and error is None:
                        error = str(event.data.get("message") or "Review engine failed")
                    elif event.type == "session_started":
                        review_session_id = (
                            str(event.data.get("session_id") or "") or None
                        )
                    elif (
                        event.type == "usage"
                        and event.data.get("session_id")
                    ):
                        review_session_id = str(event.data["session_id"])
                    await self._publish({
                        "type": "review_event",
                        "data": {
                            **event.data,
                            "event_type": event.type,
                            "task_id": task.id,
                            "step_key": step.key,
                            "step_run_id": step_run.id,
                            "review_run_id": review_run.id,
                        },
                    })
            except Exception as exc:
                error = str(exc)

        if review_session_id and ts is not None:
            ts.review_session_id = review_session_id
            ts.save(only=[TaskStep.review_session_id])

        response = "".join(response_parts)
        try:
            report = self._parse_report(response) if error is None else self._error_report(error)
        except ValueError as exc:
            error = str(exc)
            report = self._error_report(error)

        passed = bool(report.get("passed", False))
        review_run.response_text = response
        review_run.report_json = json.dumps(report, ensure_ascii=False)
        review_run.status = "passed" if passed else "rejected"
        review_run.error = error
        review_run.ended_at = utc_now()
        review_run.save()
        await self._emit(
            task, step, step_run, review_run,
            "passed" if passed else "rejected", report,
        )
        return ReviewOutcome(
            "passed" if passed else "rejected",
            review_run,
            report,
            tuple(events_collected),
        )

    @staticmethod
    def _assemble_prompt(
        task: Task,
        step: Step,
        artifacts_dir: Path,
        execution_output: str,
        review_prompt: str,
    ) -> str:
        wf_name = task.workflow_id or "default"
        out_dir = artifacts_dir / wf_name / task.id / step.key
        files = (
            [str(path) for path in sorted(out_dir.rglob("*")) if path.is_file()]
            if out_dir.exists()
            else []
        )
        return f"""你是 WorkStep 的阶段审核 Agent。只检查结果，不修改任何文件。

## 阶段
- key: {step.key}
- 名称: {step.label}
- 阶段要求: {step.prompt}
- 声明输出: {json.dumps(step.outputs, ensure_ascii=False)}

## 本次执行结果
{execution_output}

## 产物文件
{json.dumps(files, ensure_ascii=False, indent=2)}

## 审核要求
{review_prompt or "检查结果是否完整、正确并满足阶段要求。"}

仅返回一个 JSON 对象，不要附加 Markdown：
{{"passed":true,"score":0,"summary":"","issues":[{{"severity":"error","category":"","description":"","suggestion":""}}]}}
"""

    @staticmethod
    def _parse_report(response: str) -> dict:
        text = response.strip()
        fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
        if fenced:
            text = fenced.group(1)
        else:
            start, end = text.find("{"), text.rfind("}")
            if start >= 0 and end >= start:
                text = text[start:end + 1]
        try:
            report = json.loads(text)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("Review agent returned invalid JSON") from exc
        if not isinstance(report, dict) or not isinstance(report.get("passed"), bool):
            raise ValueError("Review report must contain boolean 'passed'")
        score = report.get("score", 0)
        if not isinstance(score, (int, float)) or isinstance(score, bool):
            raise ValueError("Review report score must be numeric")
        report["score"] = max(0, min(100, score))
        report["summary"] = str(report.get("summary", ""))
        report["issues"] = report.get("issues", []) if isinstance(report.get("issues", []), list) else []
        return report

    @staticmethod
    def _error_report(error: str) -> dict:
        return {
            "passed": False,
            "score": 0,
            "summary": "审核 Agent 执行失败。",
            "issues": [{
                "severity": "error",
                "category": "review_error",
                "description": error,
                "suggestion": "检查审核引擎配置后重试。",
            }],
        }

    async def _emit(
        self,
        task: Task,
        step: Step,
        step_run: StepRun,
        review_run: ReviewRun,
        status: str,
        report: dict | None = None,
    ) -> None:
        await self._publish({
            "type": "review_result" if report is not None else "review_status",
            "data": {
                "task_id": task.id,
                "step_key": step.key,
                "step_run_id": step_run.id,
                "review_run_id": review_run.id,
                "status": status,
                **({"report": report} if report is not None else {}),
            },
        })
