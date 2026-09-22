"""Internal workflow-domain names use Step while the legacy DB table stays put."""

from engines.core.schema import EngineConfigField
from models import StepSupplement
from schemas.task import StepExecutionConfigRequest, StepMessageRequest, StepResumeRequest
from services.workflow_runtime import WorkflowRuntime


def test_workflow_domain_exposes_step_named_types_and_methods():
    assert StepSupplement._meta.table_name == "stage_supplements"
    assert StepMessageRequest
    assert StepResumeRequest
    assert StepExecutionConfigRequest
    assert EngineConfigField.__dataclass_fields__.get("step_hidden") is not None

    for method in (
        "send_step_message",
        "resume_step_with_message",
        "restart_step_with_fresh_session",
        "get_step_execution_config",
        "update_step_execution_config",
        "reset_step_execution_config",
        "restart_from_step",
    ):
        assert hasattr(WorkflowRuntime, method), method

