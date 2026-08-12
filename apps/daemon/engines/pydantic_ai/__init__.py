"""PydanticAIEngine — built-in Python agent powered by Pydantic AI.

Package layout:

- ``engine.py`` — the PydanticAIEngine adapter (spawn / config / events).
- ``filesystem.py`` — sandboxed file read/write for the agent's tools.
- ``memory.py`` — durable project memory persisted as ``.workstep/MEMORY.md``.
- ``skills.py`` — project-scoped SKILL.md discovery/loading.
"""

from engines.pydantic_ai.engine import PydanticAIEngine
from engines.pydantic_ai.filesystem import FileSystem
from engines.pydantic_ai.memory import Memory
from engines.pydantic_ai.skills import Skill, Skills

__all__ = [
    "PydanticAIEngine",
    "FileSystem",
    "Memory",
    "Skill",
    "Skills",
]
