"""Engine-owned chat input commands shared by related adapters."""


NO_MANUAL_COMPACTION = frozenset({
    "openclaw", "pydantic_ai", "deepseek_harness",
})


def workstep_input_commands(*, goal: bool = False) -> list[dict[str, str]]:
    """Commands implemented consistently by WorkStep's shared chat input."""
    commands = [
        {
            "kind": "command",
            "name": "plan",
            "description": "切换计划模式",
            "insert_text": "/plan",
            "action": "toggle_plan",
        },
        {
            "kind": "command",
            "name": "reasoning",
            "description": "选择思考强度",
            "insert_text": "/reasoning",
            "action": "open_reasoning",
        },
        {
            "kind": "command",
            "name": "status",
            "description": "查看当前会话状态",
            "insert_text": "/status",
            "action": "show_status",
        },
        {
            "kind": "command",
            "name": "compact",
            "description": "压缩当前会话上下文",
            "insert_text": "/compact",
            "action": "prompt",
        },
    ]
    if goal:
        commands.insert(0, {
            "kind": "command",
            "name": "goal",
            "description": "设置或管理当前目标",
            "insert_text": "/goal ",
            "action": "prompt",
        })
    return commands
