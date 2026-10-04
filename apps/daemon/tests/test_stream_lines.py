"""子进程 stdout 分块行读取回归测试。

背景：Claude Code CLI 等引擎的单条 JSONL 事件（大段 tool 输出、长 assistant 消息）
可能超过 asyncio ``StreamReader`` 默认 64KiB limit，``readline()`` 会抛
``Separator is not found, and chunk exceed the limit`` 并清空已缓冲数据，
导致整轮执行中断。这里锁定分块读取行为。
"""

import asyncio
import json
import sys

import pytest
from engines.core.stream_lines import ChunkedLineReader, iter_stream_lines


def _reader(payload: bytes, **kwargs) -> ChunkedLineReader:
    stream = asyncio.StreamReader()  # 默认 limit=64KiB，与真实子进程一致
    stream.feed_data(payload)
    stream.feed_eof()
    return ChunkedLineReader(stream, **kwargs)


async def test_default_stream_reader_readline_raises_on_huge_line():
    """前置断言：原生 readline 在超长单行上确实崩溃（说明修复必要性）。"""
    # 无换行的超长数据 → 用户实际看到的报错文案。
    no_separator = asyncio.StreamReader()
    no_separator.feed_data(b"x" * (128 * 1024))

    with pytest.raises(ValueError, match="Separator is not found"):
        await no_separator.readline()

    # 有换行但整行超过 limit → 同样抛错，且已缓冲数据被清空。
    with_separator = asyncio.StreamReader()
    with_separator.feed_data(b'{"text":"' + b"x" * (128 * 1024) + b'"}\n')
    with_separator.feed_eof()

    with pytest.raises(ValueError, match="chunk is longer than limit"):
        await with_separator.readline()
    assert with_separator._buffer == b""


async def test_chunked_reader_returns_line_longer_than_stream_limit():
    payload_text = "y" * (512 * 1024)
    payload = json.dumps({"text": payload_text}).encode() + b"\n"

    reader = _reader(payload, chunk_size=1024)
    line = await reader.readline()

    assert line.endswith(b"\n")
    assert json.loads(line)["text"] == payload_text
    assert await reader.readline() == b""


async def test_chunked_reader_splits_on_arbitrary_chunk_boundaries():
    payload = b'{"a":1}\n{"b":2}\n{"c":3}\n'

    collected = [line async for line in _reader(payload, chunk_size=3)]

    assert collected == [b'{"a":1}\n', b'{"b":2}\n', b'{"c":3}\n']


async def test_chunked_reader_returns_tail_without_newline():
    collected = [line async for line in _reader(b"first\nsecond", chunk_size=4)]

    assert collected == [b"first\n", b"second"]


async def test_readline_timeout_keeps_partial_buffer():
    stream = asyncio.StreamReader()
    reader = ChunkedLineReader(stream)
    stream.feed_data(b'{"partial":')

    with pytest.raises(asyncio.TimeoutError):
        await reader.readline(timeout=0.05)

    stream.feed_data(b'"kept"}\n')
    stream.feed_eof()

    assert await reader.readline(timeout=1) == b'{"partial":"kept"}\n'


async def test_oversized_line_is_split_instead_of_raising(caplog):
    huge = b"z" * (300 * 1024)
    reader = _reader(huge + b"\nnext\n", max_line_bytes=64 * 1024, chunk_size=1024)

    fragments = [fragment async for fragment in reader]

    # 数据不丢：分片拼接后与原始负载完全一致；单片受 max_line_bytes 约束。
    assert b"".join(fragments) == huge + b"\nnext\n"
    assert len(fragments) > 1
    assert all(len(fragment) <= 64 * 1024 + 1024 for fragment in fragments[:-1])
    assert fragments[-1] == b"next\n"
    assert any("exceeded" in record.getMessage() for record in caplog.records)


async def test_iter_stream_lines_falls_back_for_non_readable_iterables():
    class FakeLines:
        def __init__(self, lines):
            self._lines = list(lines)

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._lines:
                raise StopAsyncIteration
            return self._lines.pop(0)

    collected = [line async for line in iter_stream_lines(FakeLines([b"a\n", b"b\n"]))]

    assert collected == [b"a\n", b"b\n"]


# --- 引擎级回归：超长单行 JSONL 不再中断整轮执行 ---


class FakeStream:
    def __init__(self):
        self.written = b""
        self.closed = False

    def write(self, data):
        self.written += data

    async def drain(self):
        return None

    def close(self):
        self.closed = True

    def is_closing(self):
        return self.closed

    async def read(self):
        return b""


class FakeProcess:
    """stdout 用真实 StreamReader（默认 64KiB limit），复现原始故障条件。"""

    def __init__(self, stdout: bytes, exit_code: int = 0):
        self.stdin = FakeStream()
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(stdout)
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_eof()
        self.exit_code = exit_code
        self.returncode = exit_code
        self.terminated = False
        self.killed = False

    async def wait(self):
        return self.exit_code

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


def _process_factory(process):
    async def factory(*args, **kwargs):
        return process

    return factory


def _message_text(events, event_types=("agent_message_chunk", "agent_message")) -> str:
    """从内部事件中提取助手文本（`content.text` / `content[].text` / `text`）。"""
    parts = []
    for event in events:
        if event.type not in event_types:
            continue
        content = event.data.get("content")
        if isinstance(content, dict):
            parts.append(str(content.get("text") or ""))
        elif isinstance(content, list):
            parts.extend(str(block.get("text") or "") for block in content if isinstance(block, dict))
        parts.append(str(event.data.get("text") or ""))
    return "".join(parts)


async def test_claude_code_parses_assistant_line_larger_than_64kib(monkeypatch):
    from engines.claude_code import ClaudeCodeEngine
    from services.config import config_store

    long_text = "claude " * 30000  # 约 200KB 单行 JSONL
    stdout = (
        b'{"type":"system","subtype":"init","session_id":"s1"}\n'
        + json.dumps(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": long_text}]}}
        ).encode()
        + b"\n"
        + b'{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":2},'
        + b'"session_id":"s1"}\n'
    )
    process = FakeProcess(stdout)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _process_factory(process))
    monkeypatch.setattr(
        ClaudeCodeEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    monkeypatch.setattr(config_store, "get_claude_permission_mode", lambda: "acceptEdits")

    engine = ClaudeCodeEngine()
    events = [event async for event in engine.spawn("开始任务", cwd="/tmp")]

    assert not [event for event in events if event.type == "error"]
    assert any(event.type == "status" and event.data.get("status") == "done" for event in events)
    assert long_text in _message_text(events)


async def test_codex_parses_agent_message_line_larger_than_64kib(tmp_path, monkeypatch):
    from engines.codex import CodexEngine

    long_text = "codex " * 30000
    stdout = (
        b'{"type":"thread.started","thread_id":"thread-1"}\n'
        + json.dumps(
            {
                "type": "item.completed",
                "item": {"type": "agent_message", "text": long_text},
            }
        ).encode()
        + b"\n"
    )
    process = FakeProcess(stdout)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _process_factory(process))
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))
    monkeypatch.setattr(
        "engines.codex.config_store.get_codex_config",
        lambda: {"sandbox_mode": "", "model_reasoning_effort": "", "approval_policy": ""},
    )

    engine = CodexEngine()
    events = [event async for event in engine.spawn("开始任务", cwd=str(tmp_path))]

    assert not [event for event in events if event.type == "error"]
    assert long_text in _message_text(events)


async def test_engines_do_not_read_stdout_with_stream_reader_readline():
    """守护回归：引擎/通道不得再用受 64KiB limit 约束的 readline 读子进程 stdout。"""
    import re
    from pathlib import Path

    daemon_root = Path(__file__).resolve().parent.parent
    targets = [
        *sorted((daemon_root / "engines").rglob("*.py")),
        *sorted((daemon_root / "services" / "channels").rglob("*.py")),
    ]
    pattern = re.compile(r"stdout\.readline\(|async for line in self\._process\.stdout\b")

    offenders = [
        f"{path.relative_to(daemon_root)}:{number}"
        for path in targets
        for number, text in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if pattern.search(text)
    ]

    assert offenders == [], f"请改用 engines.core.stream_lines: {offenders}"


async def test_real_subprocess_streams_line_larger_than_default_limit():
    """端到端：真实子进程输出 300KB 单行 JSON，分块读取可完整解析。"""
    program = sys.executable
    script = (
        "import json,sys;"
        "sys.stdout.write(json.dumps({'text':'q'*300000})+'\\n');"
        "sys.stdout.flush()"
    )

    process = await asyncio.create_subprocess_exec(
        program, "-c", script, stdout=asyncio.subprocess.PIPE
    )
    lines = [line async for line in iter_stream_lines(process.stdout)]
    await process.wait()

    assert len(lines) == 1
    assert json.loads(lines[0])["text"] == "q" * 300000
