"""Task API schemas."""

from datetime import datetime
from typing import Literal

from pydantic import Field

from schemas.base import BaseSchema


class CreateTaskRequest(BaseSchema):
    title: str = ""
    cwd: str
    description: str | None = None
    engine: str | None = None
    start_step_key: str | None = None
    auto_start: bool | None = None
    review_overrides: dict[str, object] | None = None
    workflow_id: str | None = None
    scheduled_start_at: datetime | None = None


class RunTaskRequest(BaseSchema):
    task_id: str
    prompt: str


class UpdateTaskRequest(BaseSchema):
    description: str | None = None
    review_overrides: dict[str, object] | None = None


class ScheduledStartRequest(BaseSchema):
    scheduled_start_at: datetime | None = None


class ReviewDecisionRequest(BaseSchema):
    review_run_id: str
    comment: str | None = None
    schedule_downstream: bool | None = None


class CoordinatorChatRequest(BaseSchema):
    content: str
    pending_insert_ids: list[str] = Field(default_factory=list)
    reset_session: bool = False


class StepMessageRequest(BaseSchema):
    content: str
    as_guidance: bool = False


class CoordinatorConfigRequest(BaseSchema):
    engine: str | None = None
    model: str | None = None
    fast_model: str | None = None
    vision_model: str | None = None
    thinking_effort: str | None = None
    provider_id: str | None = None


class StepResumeRequest(BaseSchema):
    content: str
    reset_step: bool = False


class StepExecutionConfigRequest(BaseSchema):
    engine: str
    model: str | None = None
    config: dict[str, str] = Field(default_factory=dict)
    context_mode: Literal["smart", "full", "none"] | None = None
