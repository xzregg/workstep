"""Tool safety and harness filesystem integration."""

from typing import Any

import pytest


async def _noop(event):
    return None


@pytest.mark.anyio
async def test_pydantic_ai_reads_files_through_harness(tmp_path):
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    (tmp_path / "a").write_text("harness filesystem", encoding="utf-8")
    engine = PydanticAIEngine()
    result, _ = await engine._run_agent(
        prompt="读一下那个文件",
        cwd=str(tmp_path),
        add_dirs=None,
        model=TestModel(call_tools=["read_file"]),
        on_event=_noop,
    )
    assert "harness filesystem" in str(result.output)


@pytest.mark.anyio
async def test_pydantic_ai_lists_files_through_harness(tmp_path):
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    (tmp_path / "visible.txt").write_text("ok", encoding="utf-8")
    engine = PydanticAIEngine()
    result, _ = await engine._run_agent(
        prompt="列出目录",
        cwd=str(tmp_path),
        add_dirs=None,
        model=TestModel(call_tools=["list_directory"]),
        on_event=_noop,
    )
    assert "visible.txt" in str(result.output)


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
