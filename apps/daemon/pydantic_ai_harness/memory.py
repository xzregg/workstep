"""Memory — durable project memory persisted as .workstep/MEMORY.md."""

import json
from pathlib import Path

_HEADING_PREFIX = "## "
_HEADER = """# 项目记忆（MEMORY）

> 由 WorkStep 内置 Pydantic 代理维护。任何引擎（Claude Code / Codex / ACP 等）
> 都可以直接读取本文件，了解项目记忆与约定。字符串值即原文，结构化值存为
> ```json 代码块。
"""


def _json_safe(value):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return str(value)


def _format_value(value) -> str:
    if isinstance(value, str):
        return value
    return "```json\n" + json.dumps(value, ensure_ascii=False, indent=2) + "\n```"


def _parse_value(text: str):
    text = text.strip()
    if text.startswith("```json"):
        inner = text[len("```json"):]
        if inner.endswith("```"):
            inner = inner[:-3]
        try:
            return json.loads(inner.strip())
        except (TypeError, ValueError):
            return inner.strip()
    return text


class Memory:
    """Small key/value memory backed by a Markdown file (default MEMORY.md).

    Entries are rendered as ``## <key>`` sections so the file stays human
    readable and can be inspected by any engine through its file tools.
    """

    def __init__(self, path: str | Path | None = None):
        self._path = Path(path).expanduser() if path else None
        self._data: dict = {}
        if self._path is not None and self._path.is_file():
            self._data = self._parse_file(self._path)

    @staticmethod
    def _parse_file(path: Path) -> dict:
        data: dict = {}
        current_key: str | None = None
        buffer: list[str] = []
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return data
        for line in lines:
            if line.startswith(_HEADING_PREFIX):
                if current_key is not None:
                    data[current_key] = _parse_value("\n".join(buffer))
                current_key = line[len(_HEADING_PREFIX):].strip()
                buffer = []
            elif current_key is not None:
                buffer.append(line)
        if current_key is not None:
            data[current_key] = _parse_value("\n".join(buffer))
        return data

    def set(self, key: str, value) -> None:
        self._data[key] = _json_safe(value)
        self._flush()

    def get(self, key: str, default=None):
        return self._data.get(key, default)

    def keys(self) -> list[str]:
        return list(self._data)

    def items(self) -> dict:
        return dict(self._data)

    def clear(self) -> None:
        self._data = {}
        self._flush()

    def _render(self) -> str:
        entries = []
        for key, value in self._data.items():
            entries.append(f"{_HEADING_PREFIX}{key}\n{_format_value(value)}")
        body = "\n\n".join(entries)
        return f"{_HEADER}\n{body}\n" if body else _HEADER

    def _flush(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(self._render(), encoding="utf-8")
