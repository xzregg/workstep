"""Schedule API request schemas."""

from typing import Literal
from pydantic import Field

from schemas.base import BaseSchema


class CreateScheduleRequest(BaseSchema):
    notification: dict | None = None
    name: str
    target_type: Literal["project", "task"] = "project"
    target_task_id: str | None = None
    instruction: str | None = None
    stop_condition: Literal["manual", "task_terminal"] = "manual"
    workflow_id: str = ""
    task_template: dict = Field(default_factory=dict)
    rule: dict
    execution_mode: Literal["workflow", "immediate", "manual"] = "workflow"
    overlap_policy: Literal["skip", "parallel", "queue"] = "skip"


class UpdateScheduleRequest(BaseSchema):
    notification: dict | None = None
    target_type: Literal["project", "task"] | None = None
    target_task_id: str | None = None
    instruction: str | None = None
    stop_condition: Literal["manual", "task_terminal"] | None = None
    name: str | None = None
    workflow_id: str | None = None
    task_template: dict | None = None
    rule: dict | None = None
    execution_mode: Literal["workflow", "immediate", "manual"] | None = None
    overlap_policy: Literal["skip", "parallel", "queue"] | None = None

