"""按块读取子进程 stdout 并切分行的共享工具。

asyncio ``StreamReader`` 的 ``readline()`` / ``async for line in stream`` 依赖
``readuntil(b"\\n")``，受 ``limit``（默认 64 KiB）约束：单行超过上限时抛出
``Separator is not found, and chunk exceed the limit``，并且**已缓冲数据会被清空**
（LLM CLI 的一条 JSONL 事件即可轻易超过 64 KiB，例如大段 tool 输出、system init、
长 assistant 消息），导致整轮执行中断且日志丢失。

这里的实现改为 ``read(chunk)`` + 自管理缓冲，不受 separator 限制：
- 任意长度的行都能完整读出；
- 单行超过 ``max_line_bytes`` 时按块切出并告警，流继续而不是中断；
- 支持可选 ``timeout``（供 codex 轮询 live 消息队列使用），超时保留已缓冲数据。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator

logger = logging.getLogger(__name__)

#: 单次 ``read()`` 的块大小。
DEFAULT_CHUNK_SIZE = 64 * 1024

#: 单行安全上限；超过后切块输出（JSON 解析会失败并告警），避免无界内存增长。
DEFAULT_MAX_LINE_BYTES = 256 * 1024 * 1024


class ChunkedLineReader:
    """把任意提供 ``read(n)`` 的异步字节流按 ``\\n`` 切分为行。"""

    def __init__(
        self,
        stream: Any,
        *,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        max_line_bytes: int = DEFAULT_MAX_LINE_BYTES,
    ) -> None:
        self._stream = stream
        self._chunk_size = max(1, int(chunk_size))
        self._max_line_bytes = max(self._chunk_size, int(max_line_bytes))
        self._buffer = bytearray()
        self._eof = False

    @property
    def stream(self) -> Any:
        """底层字节流，便于调用方判断读取器是否与当前进程匹配。"""
        return self._stream

    async def readline(self, timeout: float | None = None) -> bytes:
        """返回一行（含结尾 ``\\n``）；流结束且无残留数据时返回 ``b""``。

        ``timeout`` 只作用于等待新数据；超时抛 ``asyncio.TimeoutError``，
        已缓冲数据保留，下次调用继续拼接。
        """
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self._buffer[: newline + 1])
                del self._buffer[: newline + 1]
                return line

            if self._eof:
                line = bytes(self._buffer)
                self._buffer.clear()
                return line

            if len(self._buffer) >= self._max_line_bytes:
                logger.warning(
                    "Single stdout line exceeded %d bytes; splitting it to keep the stream alive",
                    self._max_line_bytes,
                )
                line = bytes(self._buffer)
                self._buffer.clear()
                return line

            if timeout is None:
                chunk = await self._stream.read(self._chunk_size)
            else:
                chunk = await asyncio.wait_for(
                    self._stream.read(self._chunk_size), timeout=timeout
                )
            if not chunk:
                self._eof = True
            else:
                self._buffer.extend(chunk)

    def __aiter__(self) -> "ChunkedLineReader":
        return self

    async def __anext__(self) -> bytes:
        line = await self.readline()
        if not line:
            raise StopAsyncIteration
        return line


def iter_stream_lines(stream: Any) -> AsyncIterator[bytes]:
    """按行迭代子进程 stdout。

    兼容测试替身：没有 ``read()`` 的对象退化为直接 ``async for`` 迭代。
    """
    if hasattr(stream, "read"):
        return ChunkedLineReader(stream)
    return _aiter_fallback(stream)


async def _aiter_fallback(stream: Any) -> AsyncIterator[bytes]:
    async for line in stream:
        yield line
