"""Schedule API request schemas."""

from typing import Literal

from schemas.base import BaseSchema


class CreateScheduleRequest(BaseSchema):
    name: str
    workflow_id: str
    task_template: dict
    rule: dict
    execution_mode: Literal["workflow", "immediate", "manual"] = "workflow"
    overlap_policy: Literal["skip", "parallel", "queue"] = "skip"


class UpdateScheduleRequest(BaseSchema):
    name: str | None = None
    workflow_id: str | None = None
    task_template: dict | None = None
    rule: dict | None = None
    execution_mode: Literal["workflow", "immediate", "manual"] | None = None
    overlap_policy: Literal["skip", "parallel", "queue"] | None = None

