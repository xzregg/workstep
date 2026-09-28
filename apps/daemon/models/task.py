"""Task and TaskStep models."""

import peewee as pw
from models.base import BaseModel
from models.fields import UTCDateTimeField


class Task(BaseModel):
    """A task (card) in the workflow pipeline."""

    class Meta:
        table_name = "tasks"
        indexes = (
            (("archived", "updated_at"), False),
            (("workflow_id", "archived", "updated_at"), False),
            (("scheduled_start_state", "scheduled_start_at"), False),
        )

    id = pw.TextField(primary_key=True)
    title = pw.TextField()
    description = pw.TextField(null=True)
    cwd = pw.TextField()
    workflow_id = pw.TextField(null=True)  # FK-like: which workflow this task belongs to
    status = pw.TextField(default="ready")  # ready / queued / running / paused / stopped
    archived = pw.IntegerField(default=0)  # 1 = hidden from the active board
    engine = pw.TextField(null=True)  # claude / codex / hermes
    model = pw.TextField(null=True)
    coordinator_engine = pw.TextField(null=True)
    coordinator_model = pw.TextField(null=True)
    coordinator_fast_model = pw.TextField(null=True)
    coordinator_vision_model = pw.TextField(null=True)
    coordinator_thinking_effort = pw.TextField(null=True)
    coordinator_provider_id = pw.TextField(null=True)
    active_workflow_run_id = pw.TextField(null=True)
    state_version = pw.IntegerField(default=0)
    next_message_sequence = pw.IntegerField(default=1)
    pipeline_version = pw.TextField(null=True)
    review_overrides_json = pw.TextField(null=True)
    creator_id = pw.TextField(null=True)
    creator_username = pw.TextField(null=True)
    creator_name = pw.TextField(null=True)
    creator_device_id = pw.TextField(null=True)
    creator_device_name = pw.TextField(null=True)
    scheduled_start_at = UTCDateTimeField(null=True)
    scheduled_start_state = pw.TextField(null=True)  # pending / missed / failed
    scheduled_start_error = pw.TextField(null=True)
    source_dispatch_id = pw.TextField(null=True, unique=True)
    source_project_id = pw.TextField(null=True)
    source_task_id = pw.TextField(null=True)
    source_step_key = pw.TextField(null=True)
    input_manifest_json = pw.TextField(null=True)
    dispatch_lineage_json = pw.TextField(null=True)
    created_at = UTCDateTimeField()
    updated_at = UTCDateTimeField()


class TaskStep(BaseModel):
    """Per-step progress tracking for a task."""

    task = pw.ForeignKeyField(Task, backref="steps")
    step_key = pw.TextField()  # 'req' / 'ui' / 'frontend' / etc.
    status = pw.TextField(default="pending")  # pending / running / passed / failed / skipped
    engine = pw.TextField(null=True)
    session_id = pw.TextField(null=True)  # 该任务该步骤专属的引擎会话（重跑时复用）
    session_provider = pw.TextField(null=True)  # 建立该会话时使用的供应商（供应商变更时失效）
    review_session_id = pw.TextField(null=True)  # 该任务该步骤专属的审核会话（与执行会话隔离）
    execution_config_json = pw.TextField(null=True)  # 当前任务对流程步骤执行配置的覆盖
    pending_handoff_json = pw.TextField(null=True)  # 跨引擎重跑待消费的交接元数据
    rework_feedback = pw.TextField(null=True)  # 下游验证步骤下发的返工反馈（重跑时注入 prompt）
    review_feedback = pw.TextField(null=True)  # 人工审核驳回原因（重跑该步骤时注入 prompt）
    started_at = UTCDateTimeField(null=True)
    ended_at = UTCDateTimeField(null=True)
    error = pw.TextField(null=True)

    class Meta:
        primary_key = pw.CompositeKey("task", "step_key")
