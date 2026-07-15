"""Task API schemas."""

from schemas.base import BaseSchema


class CreateTaskRequest(BaseSchema):
    title: str
    cwd: str
    description: str | None = None
    engine: str = "claude"


class RunTaskRequest(BaseSchema):
    task_id: str
    prompt: str
