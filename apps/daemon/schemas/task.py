"""Task API schemas."""

from schemas.base import BaseSchema


class CreateTaskRequest(BaseSchema):
    title: str
    cwd: str
    description: str | None = None
    engine: str = "claude"
    start_step_key: str | None = None
    review_overrides: dict[str, object] | None = None
    workflow_id: str | None = None


class RunTaskRequest(BaseSchema):
    task_id: str
    prompt: str


class UpdateTaskRequest(BaseSchema):
    description: str | None = None
    review_overrides: dict[str, object] | None = None


class ReviewDecisionRequest(BaseSchema):
    review_run_id: str
    comment: str | None = None
