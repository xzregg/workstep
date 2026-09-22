"""思考增量事件聚合。

``agent_thought_chunk``（含 ``subagent`` 事件内层包裹的思考/正文增量）是
token 级细粒度事件，长回合里占事件量的绝大部分（实测单条消息 1.6 万事件
中约 88% 为思考类）。逐条走日志 + WS 广播会导致：JSONL 膨胀、WS 消息风暴、
前端 store 每条事件复制一次事件数组（即使有封顶也持续抖动）。

本模块把**连续同类**的思考增量在进日志/广播之前合并为少量大事件：

- 合并签名完全一致才合并（顶层思考流；subagent 按 task_id/status/stage/
  description + 内层类型分组），任何字段变化立即断流，保证语义不漂移；
- 字符预算 / 时间预算任一达到即冲刷，思考流的实时观感延迟有上界；
- 调用方在遇到不可合并事件、回合结束时必须冲刷，保证事件顺序；
- 合并事件沿用该段第一条事件的形状（文本拼接、时间戳取第一条），
  前端照旧拼接 delta，完全无感知。
"""

from __future__ import annotations

import copy
import time
from typing import Any, Callable

#: 单条合并事件的字符预算：累计达到即冲刷（约半屏思考文本）。
THOUGHT_CHAR_BUDGET = 512

#: 单条合并事件的时间预算（秒）：思考流展示延迟的上界。
THOUGHT_TIME_BUDGET_S = 0.5

#: subagent 内层可合并的事件类型（思考增量 + 子代理正文增量）。
_INNER_MERGEABLE = frozenset({"agent_thought_chunk", "agent_message_chunk"})


def _content_text(data: Any) -> str | None:
    """从 ``{"content": {"text": ...}}`` 形状中取出文本；形状不符返回 None。"""
    if not isinstance(data, dict):
        return None
    content = data.get("content")
    if not isinstance(content, dict):
        return None
    text = content.get("text")
    return text if isinstance(text, str) else None


def merge_key(event: dict) -> tuple | None:
    """可合并事件的签名；返回 None 表示不可合并（原样逐条处理）。"""
    kind = event.get("type")
    data = event.get("data")
    if not isinstance(data, dict):
        return None
    if kind == "agent_thought_chunk":
        return ("top",) if _content_text(data) is not None else None
    if kind == "subagent":
        inner = data.get("event")
        if not isinstance(inner, dict) or inner.get("type") not in _INNER_MERGEABLE:
            return None
        if _content_text(inner.get("data")) is None:
            return None
        return (
            "subagent",
            data.get("task_id"),
            data.get("status"),
            data.get("stage"),
            data.get("description"),
            inner.get("type"),
        )
    return None


def _read_text(event: dict, key: tuple) -> str:
    data = event.get("data") or {}
    if key[0] == "top":
        return _content_text(data) or ""
    inner = (data.get("event") or {}).get("data")
    return _content_text(inner) or ""


def _write_text(merged: dict, key: tuple, text: str) -> None:
    data = merged.setdefault("data", {})
    if key[0] == "top":
        data.setdefault("content", {})["text"] = text
        return
    inner = data.setdefault("event", {}).setdefault("data", {})
    inner.setdefault("content", {})["text"] = text


class ThoughtChunkAggregator:
    """把连续同类思考增量合并为少量事件（非线程安全：单回合事件循环内使用）。"""

    def __init__(
        self,
        *,
        char_budget: int = THOUGHT_CHAR_BUDGET,
        time_budget_s: float = THOUGHT_TIME_BUDGET_S,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._char_budget = max(1, int(char_budget))
        self._time_budget = max(0.0, float(time_budget_s))
        self._now = now
        self._key: tuple | None = None
        self._base: dict | None = None
        self._texts: list[str] = []
        self._chars = 0
        self._started = 0.0

    @staticmethod
    def is_mergeable(event: dict) -> bool:
        return merge_key(event) is not None

    def offer(self, event: dict) -> dict | None:
        """加入一个可合并事件。

        返回需要立即处理的合并事件（预算达到或签名切换产生的旧流），
        否则返回 None（已缓冲）。不可合并事件直接返回 None 且不缓冲。
        """
        key = merge_key(event)
        if key is None:
            return None
        text = _read_text(event, key)
        if self._key != key:
            pending = self._take()
            self._start(key, event, text)
            if self._chars >= self._char_budget:
                # 单条超大增量立即落盘；若旧流也有挂起，先返回旧流保证顺序，
                # 超大的新流在下一次触发点冲刷。
                overflow = self._take()
                return pending if pending is not None else overflow
            return pending
        self._texts.append(text)
        self._chars += len(text)
        if (
            self._chars >= self._char_budget
            or (self._now() - self._started) >= self._time_budget
        ):
            return self._take()
        return None

    def flush(self) -> list[dict]:
        """回合结束 / 非合并事件到来时冲刷挂起的思考流。"""
        pending = self._take()
        return [pending] if pending is not None else []

    def _start(self, key: tuple, event: dict, text: str) -> None:
        self._key = key
        self._base = event
        self._texts = [text]
        self._chars = len(text)
        self._started = self._now()

    def _take(self) -> dict | None:
        if self._key is None or self._base is None or not self._texts:
            self._key = None
            self._base = None
            self._texts = []
            self._chars = 0
            return None
        merged = copy.deepcopy(self._base)
        _write_text(merged, self._key, "".join(self._texts))
        self._key = None
        self._base = None
        self._texts = []
        self._chars = 0
        return merged
