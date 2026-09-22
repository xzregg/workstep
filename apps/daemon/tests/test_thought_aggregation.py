"""ThoughtChunkAggregator — 思考增量聚合。"""

from agent_assistants.thought_aggregation import ThoughtChunkAggregator


def thought(text: str) -> dict:
    return {"type": "agent_thought_chunk", "data": {"content": {"text": text}}, "timestamp": 1}


def subagent_thought(text: str, task: str = "t1", status: str = "running", stage: str = "progress") -> dict:
    return {
        "type": "subagent",
        "data": {
            "task_id": task,
            "status": status,
            "stage": stage,
            "description": "d",
            "event": {
                "type": "agent_thought_chunk",
                "data": {"content": {"text": text}},
                "timestamp": 2,
            },
        },
    }


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def test_mergeable_detection():
    agg = ThoughtChunkAggregator()
    assert agg.is_mergeable(thought("a"))
    assert agg.is_mergeable(subagent_thought("a"))
    assert not agg.is_mergeable({"type": "tool_call", "data": {}})
    assert not agg.is_mergeable({"type": "subagent", "data": {"status": "running"}})  # 无内层事件
    assert not agg.is_mergeable({"type": "agent_thought_chunk", "data": {}})  # 形状不符
    assert not agg.is_mergeable({"type": "agent_message_chunk", "data": {"content": {"text": "x"}}})  # 顶层正文不聚合


def test_char_budget_flushes_merged_event():
    clock = FakeClock()
    agg = ThoughtChunkAggregator(char_budget=10, time_budget_s=999, now=clock)
    assert agg.offer(thought("aaaa")) is None       # 4 字符，未达预算
    assert agg.offer(thought("bbbb")) is None       # 8 字符，未达预算
    merged = agg.offer(thought("cccc"))             # 12 字符 ≥ 10 → 冲刷
    assert merged is not None
    assert merged["type"] == "agent_thought_chunk"
    assert merged["data"]["content"]["text"] == "aaaabbbbcccc"
    assert merged["timestamp"] == 1  # 沿用该段第一条事件
    assert agg.flush() == []  # 已清空


def test_time_budget_flushes_even_when_small():
    clock = FakeClock()
    agg = ThoughtChunkAggregator(char_budget=9999, time_budget_s=0.5, now=clock)
    assert agg.offer(thought("a")) is None
    clock.advance(0.6)
    merged = agg.offer(thought("b"))
    assert merged is not None
    assert merged["data"]["content"]["text"] == "ab"


def test_flush_returns_pending_and_clears():
    agg = ThoughtChunkAggregator(char_budget=9999, time_budget_s=999)
    agg.offer(thought("hello "))
    agg.offer(thought("world"))
    pending = agg.flush()
    assert len(pending) == 1
    assert pending[0]["data"]["content"]["text"] == "hello world"
    assert agg.flush() == []


def test_signature_change_flushes_previous_run():
    agg = ThoughtChunkAggregator(char_budget=9999, time_budget_s=999)
    agg.offer(subagent_thought("aa", task="t1"))
    merged = agg.offer(subagent_thought("bb", task="t2"))  # task 变化 → 旧流冲刷
    assert merged is not None
    assert merged["data"]["task_id"] == "t1"
    assert merged["data"]["event"]["data"]["content"]["text"] == "aa"
    pending = agg.flush()
    assert pending[0]["data"]["task_id"] == "t2"
    assert pending[0]["data"]["event"]["data"]["content"]["text"] == "bb"


def test_top_and_subagent_streams_do_not_mix():
    agg = ThoughtChunkAggregator(char_budget=9999, time_budget_s=999)
    agg.offer(thought("top1"))
    merged = agg.offer(subagent_thought("sub1"))  # 签名不同 → 先冲顶层
    assert merged is not None
    assert merged["type"] == "agent_thought_chunk"
    assert merged["data"]["content"]["text"] == "top1"
    pending = agg.flush()
    assert pending[0]["type"] == "subagent"
    assert pending[0]["data"]["event"]["data"]["content"]["text"] == "sub1"


def test_subagent_lifecycle_change_breaks_run():
    agg = ThoughtChunkAggregator(char_budget=9999, time_budget_s=999)
    agg.offer(subagent_thought("x", status="running"))
    merged = agg.offer(subagent_thought("y", status="completed"))
    assert merged is not None
    assert merged["data"]["status"] == "running"
    assert merged["data"]["event"]["data"]["content"]["text"] == "x"


def test_original_event_not_mutated():
    agg = ThoughtChunkAggregator(char_budget=2, time_budget_s=999)
    first = thought("aaaa")
    merged = agg.offer(first)
    assert merged is not None
    assert first["data"]["content"]["text"] == "aaaa"  # 原事件保持原样（journaled_events 去重依赖它）


def test_offer_ignores_non_mergeable():
    agg = ThoughtChunkAggregator()
    assert agg.offer({"type": "tool_call", "data": {}}) is None
    assert agg.flush() == []
