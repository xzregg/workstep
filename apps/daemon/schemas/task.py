"""Task API schemas."""

from schemas.base import BaseSchema


class CreateTaskRequest(BaseSchema):
    title: str
    cwd: str
    description: str | None = None
    engine: str = "claude"
    start_step_key: str | None = None


class RunTaskRequest(BaseSchema):
    task_id: str
    prompt: str


class UpdateTaskRequest(BaseSchema):
    description: str | None = None
