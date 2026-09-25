"""Public ACP plan protocol shared by every engine adapter."""

from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent
from engines.core.plans import plan_event


class PlanEngine(AcpEngineBase):
    @staticmethod
    def is_installed(): return True

    @staticmethod
    def get_version(): return "test"

    @staticmethod
    def resolve_binary(): return "test"

    async def spawn(self, prompt, cwd, **kwargs):
        if False:
            yield

    async def stop(self): return None

    async def inject_response(self, tool_use_id, content): return None

    @property
    def supports_resume(self): return False

    @property
    def supports_interactive(self): return False

    def build_resume_params(self, session_id): return {}


def test_plan_event_uses_acp_stable_snapshot_shape():
    event = plan_event([
        {"content": "分析代码", "priority": "high", "status": "completed"},
        {"step": "实现功能", "status": "inProgress"},
    ], explanation="按 Base seam 统一")

    assert event.type == "plan"
    assert event.data == {
        "entries": [
            {"content": "分析代码", "priority": "high", "status": "completed"},
            {"content": "实现功能", "priority": "medium", "status": "in_progress"},
        ],
        "explanation": "按 Base seam 统一",
    }


def test_plan_event_preserves_optional_step_detail():
    event = plan_event([{
        "content": "环境检查",
        "detail": "检查运行环境与依赖版本",
        "status": "pending",
    }])

    assert event.data["entries"] == [{
        "content": "环境检查",
        "detail": "检查运行环境与依赖版本",
        "priority": "medium",
        "status": "pending",
    }]


def test_base_engine_normalizes_claude_todo_snapshot_to_acp_plan():
    event = PlanEngine().normalize_event(InternalEvent(type="tool_call", data={
		"tool_call_id": "todo-1",
		"title": "TodoWrite",
		"raw_input": {"todos": [
            {"content": "分析代码", "status": "completed"},
            {"content": "实现功能", "status": "in_progress"},
        ]},
	}))

    assert event is not None
    assert event.type == "plan"
    assert event.data["entries"] == [
        {"content": "分析代码", "priority": "medium", "status": "completed"},
        {"content": "实现功能", "priority": "medium", "status": "in_progress"},
    ]


def test_base_engine_reduces_claude_task_tools_to_full_plan_snapshots():
    engine = PlanEngine()

    created = engine.normalize_event(InternalEvent(type="tool_call", data={
		"tool_call_id": "create-call-1",
		"title": "TaskCreate",
		"raw_input": {"subject": "实现后端", "description": "接入 Plan"},
	}))
    assigned = engine.normalize_event(InternalEvent(type="tool_call_update", data={
		"tool_call_id": "create-call-1",
		"status": "completed",
		"raw_output": '{"task":{"id":"task-7","subject":"实现后端"}}',
        "is_error": False,
	}))
    updated = engine.normalize_event(InternalEvent(type="tool_call", data={
		"tool_call_id": "update-call-1",
		"title": "TaskUpdate",
		"raw_input": {"taskId": "task-7", "status": "in_progress"},
	}))

    assert created is not None and created.type == "plan"
    assert assigned is not None and assigned.type == "plan"
    assert updated is not None and updated.type == "plan"
    assert updated.data["entries"] == [{
        "content": "实现后端",
        "detail": "接入 Plan",
        "priority": "medium",
        "status": "in_progress",
    }]


def test_base_engine_replaces_plan_from_claude_task_list_result():
    engine = PlanEngine()
    started = engine.normalize_event(InternalEvent(type="tool_call", data={
        "tool_call_id": "list-call-1", "title": "TaskList", "raw_input": {},
    }))
    listed = engine.normalize_event(InternalEvent(type="tool_call_update", data={
		"tool_call_id": "list-call-1",
		"status": "completed",
		"raw_output": '{"tasks":['
        '{"id":"1","subject":"后端","status":"completed"},'
        '{"id":"2","subject":"前端","status":"in_progress"}]}',
	}))

    assert started is not None and started.type == "tool_call"
    assert listed is not None and listed.type == "plan"
    assert listed.data["entries"] == [
        {"content": "后端", "priority": "medium", "status": "completed"},
        {"content": "前端", "priority": "medium", "status": "in_progress"},
    ]


def test_base_engine_uses_description_fallback_for_claude_task_tools():
    engine = PlanEngine()

    created = engine.normalize_event(InternalEvent(type="tool_call", data={
		"tool_call_id": "create-call-2",
		"title": "TaskCreate",
		"raw_input": {"description": "实现后端", "prompt": "详细提示"},
	}))
    engine.normalize_event(InternalEvent(type="tool_call", data={
        "tool_call_id": "list-call-2", "title": "TaskList", "raw_input": {},
    }))
    listed = engine.normalize_event(InternalEvent(type="tool_call_update", data={
		"tool_call_id": "list-call-2",
		"status": "completed",
		"raw_output": '{"tasks":[{"id":"1","description":"后端","status":"completed"},'
        '{"id":"2","description":"前端","status":"running"}]}',
	}))

    assert created is not None and created.type == "plan"
    assert created.data["entries"][0]["content"] == "实现后端"
    assert listed is not None and listed.type == "plan"
    assert listed.data["entries"] == [
        {"content": "后端", "priority": "medium", "status": "completed"},
        {"content": "前端", "priority": "medium", "status": "in_progress"},
    ]


def test_base_engine_maps_running_and_paused_status_to_in_progress():
    engine = PlanEngine()
    engine.normalize_event(InternalEvent(type="tool_call", data={
		"tool_call_id": "create-call-3",
		"title": "TaskCreate",
		"raw_input": {"description": "实现前端"},
	}))
    updated = engine.normalize_event(InternalEvent(type="tool_call", data={
		"tool_call_id": "update-call-3",
		"title": "TaskUpdate",
		"raw_input": {"taskId": "pending:create-call-3", "status": "running"},
	}))

    assert updated is not None and updated.type == "plan"
    assert updated.data["entries"] == [{
        "content": "实现前端",
        "priority": "medium",
        "status": "in_progress",
    }]


def test_base_engine_keeps_subagent_lifecycle_out_of_plan_snapshots():
    engine = PlanEngine()

    started = engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "task-7",
        "description": "实现后端",
        "status": "running",
        "stage": "started",
        "tool_use_id": "task-call-1",
    }))
    progressed = engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "task-7",
        "description": "实现后端",
        "status": "running",
        "stage": "progress",
    }))
    completed = engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "task-7",
        "description": "实现后端",
        "status": "completed",
        "stage": "notification",
    }))
    # 子代理生命周期事件透传，不生成计划。
    assert started is not None and started.type == "subagent"
    assert progressed is not None and progressed.type == "subagent"
    assert completed is not None and completed.type == "subagent"


def test_base_engine_keeps_task_list_separate_from_subagents():
    engine = PlanEngine()
    engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "agent-1", "description": "调研", "status": "running",
    }))
    engine.normalize_event(InternalEvent(type="tool_call", data={
        "tool_call_id": "list-call", "title": "TaskList", "raw_input": {},
    }))
    listed = engine.normalize_event(InternalEvent(type="tool_call_update", data={
        "tool_call_id": "list-call", "status": "completed",
        "raw_output": '{"tasks":[{"id":"task-1","subject":"实现后端"}]}',
    }))

    assert listed is not None and listed.type == "plan"
    assert listed.data["entries"] == [{
        "content": "实现后端",
        "priority": "medium",
        "status": "pending",
    }]


def test_base_engine_preserves_subagent_tool_result():
    engine = PlanEngine()

    engine.normalize_event(InternalEvent(type="tool_call", data={
		"tool_call_id": "task-call-9",
		"title": "Task",
		"raw_input": {"description": "调研 ACP 协议", "prompt": "查文档"},
	}))
    engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "task-9",
        "description": "调研 ACP 协议",
        "status": "running",
        "stage": "started",
        "tool_use_id": "task-call-9",
    }))
    finished = engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "task-9",
        "description": "调研 ACP 协议",
        "status": "completed",
        "stage": "notification",
        "summary": "结论：ACP stable plan 是整表快照",
    }))
    result = engine.normalize_event(InternalEvent(type="tool_call_update", data={
		"tool_call_id": "task-call-9",
		"status": "completed",
		"raw_output": '{"task":{"id":"task-9"}}',
        "is_error": False,
	}))

    assert finished is not None and finished.type == "subagent"
    assert result is not None and result.type == "tool_call_update"


def test_base_engine_preserves_failed_subagent_status():
    engine = PlanEngine()
    engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "task-11",
        "description": "失败子代理",
        "status": "running",
        "stage": "started",
    }))
    failed = engine.normalize_event(InternalEvent(type="subagent", data={
        "task_id": "task-11",
        "description": "失败子代理",
        "status": "failed",
        "stage": "notification",
        "summary": "工具执行错误",
    }))
    assert failed is not None and failed.type == "subagent"
    assert failed.data["status"] == "failed"


def test_base_engine_keeps_codex_spawn_agent_out_of_plan():
    engine = PlanEngine()

    started = engine.normalize_event(InternalEvent(type="tool_call", data={
		"tool_call_id": "agent-1",
		"title": "spawnAgent",
		"raw_input": {"prompt": "分析 provider 代码", "model": "gpt-5.6"},
	}))
    finished = engine.normalize_event(InternalEvent(type="tool_call_update", data={
		"tool_call_id": "agent-1",
		"status": "completed",
		"raw_output": '{"agents_states":[{"message":"已完成","status":"completed"}]}',
        "is_error": False,
	}))

    assert started is not None and started.type == "tool_call"
    assert finished is not None and finished.type == "tool_call_update"


def test_base_engine_preserves_acp_style_subagent_tool():
    """带 prompt 的子代理工具调用仍作为工具事件展示。"""
    engine = PlanEngine()

    started = engine.normalize_event(InternalEvent(type="tool_call", data={
		"tool_call_id": "call-1",
		"title": "调用子代理分析依赖",
		"raw_input": {"prompt": "分析 provider 代码并给出结论", "model": "auto"},
	}))
    progressed = engine.normalize_event(InternalEvent(type="tool_call", data={
		"tool_call_id": "call-2",
		"title": "Bash",
		"raw_input": {"command": "ls -la"},
	}))
    finished = engine.normalize_event(InternalEvent(type="tool_call_update", data={
		"tool_call_id": "call-1",
		"status": "completed",
		"raw_output": '{"status":"completed"}',
        "is_error": False,
	}))

    assert started is not None and started.type == "tool_call"
    # 普通命令工具不进入 plan。
    assert progressed is not None and progressed.type == "tool_call"
    assert finished is not None and finished.type == "tool_call_update"


def test_acp_engine_preserves_subagent_tool_call():
    """Hermes 全链路：ACP 子代理工具调用保持工具事件。"""
    from engines.hermes import HermesEngine
    from acp import schema

    engine = HermesEngine()
    started = engine._map_notification(schema.ToolCallStart(
        session_update="tool_call",
        tool_call_id="call-1",
        title="调用子代理实现后端",
        kind="other",
        raw_input={"prompt": "实现后端接口", "model": "auto"},
    ))
    assert started is not None and started.type == "tool_call"

    normalized = engine.normalize_event(started)
    assert normalized is not None and normalized.type == "tool_call"

    done = engine._map_notification(schema.ToolCallProgress(
        session_update="tool_call_update",
        tool_call_id="call-1",
        title="调用子代理实现后端",
        status="completed",
        raw_output="完成",
    ))
    normalized_done = engine.normalize_event(done)
    assert normalized_done is not None and normalized_done.type == "tool_call_update"
