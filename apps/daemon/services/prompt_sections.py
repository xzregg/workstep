"""Readable boundaries for application-owned prompt sections."""

import json


def prompt_section(name: str, content: str) -> str:
    """Keep supplied text intact, with each boundary on its own line."""
    body = content if not content or content.endswith("\n") else content + "\n"
    return f"<{name}>\n{body}</{name}>\n"


def prompt_context(values, name: str = "context", *,
                   description: str = "JSON context for the current request.") -> str:
    """Wrap structured context as JSON; XML marks only the section boundary."""
    payload = json.dumps(values, ensure_ascii=False, indent=2, default=str)
    return prompt_section(name, description + "\n\n" + payload)
