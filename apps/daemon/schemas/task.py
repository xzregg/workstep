"""Task API schemas."""

from datetime import datetime

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


class CoordinatorChatRequest(BaseSchema):
    content: str


class StageMessageRequest(BaseSchema):
    content: str
    as_guidance: bool = False


class CoordinatorConfigRequest(BaseSchema):
    engine: str | None = None
    model: str | None = None
    fast_model: str | None = None
    vision_model: str | None = None
    thinking_effort: str | None = None
    provider_id: str | None = None


class StageResumeRequest(BaseSchema):
    content: str
