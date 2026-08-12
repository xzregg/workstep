"""Tool failures must never kill the agent run (pydantic-ai 2.23 raises)."""

from typing import Any

import pytest


async def _noop(event):
    return None


@pytest.mark.anyio
async def test_pydantic_ai_tool_error_does_not_kill_run():
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    engine = PydanticAIEngine()
    result, _ = await engine._run_agent(
        prompt="读一下那个文件",
        cwd="/tmp",
        add_dirs=None,
        model=TestModel(call_tools=["read_file"]),
        on_event=_noop,
    )
    assert "文件不存在" in str(result.output)


@pytest.mark.anyio
async def test_pydantic_ai_list_tool_error_is_visible_to_model():
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    engine = PydanticAIEngine()
    result, _ = await engine._run_agent(
        prompt="列出不存在的目录",
        cwd="/tmp/__workstep_missing_dir__",
        add_dirs=None,
        model=TestModel(call_tools=["list_files"]),
        on_event=_noop,
    )
    assert "目录不存在" in str(result.output)


def test_tool_error_value_matches_return_type():
    from engines.pydantic_ai import PydanticAIEngine

    exc = ValueError("文件不存在: x")
    text = PydanticAIEngine._tool_error_value(str, exc)
    assert isinstance(text, str)
    assert "文件不存在" in text

    items = PydanticAIEngine._tool_error_value(list[str], exc)
    assert isinstance(items, list)
    assert "文件不存在" in items[0]

    payload = PydanticAIEngine._tool_error_value(dict[str, Any], exc)
    assert payload == {"ok": False, "error": text}
