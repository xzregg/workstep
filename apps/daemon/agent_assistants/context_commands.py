"""Host-owned context controls, recognized only as a leading command token."""

RESET_REPLY = "上下文已清空，下一条消息将开启新的引擎会话。"


def reset_command(content: str) -> str | None:
    parts = (content or '').strip().split(maxsplit=1)
    if parts and parts[0] in {'/new', '/clear'}:
        return parts[1] if len(parts) > 1 else ''
    return None


def context_content(content: str) -> str:
    remainder = reset_command(content)
    return content if remainder is None else remainder
