"""下发前端出口处的超大工具载荷截断。

子代理/工具的单条 ``raw_output`` 可达数十 MB（例如一次读取超大文件、聚合
transcript）。JSONL 日志按设计保留全量，但下发给前端的三个出口——WS 实时
广播（``base._publish``）、``messageEvents`` 分页与旧 events_json 回放
（``chat_session._detail_agui_events``）——只需要预览：前端展示本身就有
5 万字符上限，全量下发会让浏览器 JSON.parse、store 与渲染全部冻结。

实现要点：
- 只截断已知的工具载荷字段（``raw_output`` / ``raw_input`` / ``output``），
  消息正文 ``content``、思考增量等绝不触碰；
- copy-on-write：不发生截断时原样返回同一引用，发布热路径近零开销，
  且不会就地改写被日志/会话状态共享的字典；
- 截断标记内嵌在文本尾部并带原始长度，前端可直接展示。
"""

from __future__ import annotations

from typing import Any

#: 单字段截断上限（字符）。低于前端 ToolCallRow 的 5 万显示上限，保证标记可见。
LARGE_PAYLOAD_LIMIT = 32 * 1024

#: 需要截断的工具输入/输出字段（含 AG-UI TOOL_CALL_RESULT 的 ``output``）。
LARGE_PAYLOAD_FIELDS = frozenset({"raw_output", "raw_input", "output"})


def _truncate_str(text: str) -> str:
    return (
        f"{text[:LARGE_PAYLOAD_LIMIT]}\n"
        f"……[已截断：原始 {len(text)} 字符，完整内容见服务端事件日志]"
    )


def truncate_large_tool_payloads(value: Any) -> Any:
    """递归截断事件里工具载荷字段的超大字符串。

    仅当确实发生截断时才返回新对象；否则返回原引用（identity 可比较，
    调用方无需担心无谓复制）。
    """
    if isinstance(value, dict):
        changed = False
        out: dict = {}
        for key, item in value.items():
            if (
                key in LARGE_PAYLOAD_FIELDS
                and isinstance(item, str)
                and len(item) > LARGE_PAYLOAD_LIMIT
            ):
                out[key] = _truncate_str(item)
                changed = True
                continue
            replaced = truncate_large_tool_payloads(item)
            out[key] = replaced
            if replaced is not item:
                changed = True
        return out if changed else value
    if isinstance(value, list):
        changed = False
        items: list = []
        for item in value:
            replaced = truncate_large_tool_payloads(item)
            items.append(replaced)
            if replaced is not item:
                changed = True
        return items if changed else value
    return value
