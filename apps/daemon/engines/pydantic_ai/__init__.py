"""PydanticAIEngine — built-in Python agent powered by Pydantic AI.

Package layout:

- ``engine.py`` — the PydanticAIEngine adapter (spawn / config / events).
Coding, filesystem, and skills capabilities come from ``pydantic_ai_harness``.
"""

from engines.pydantic_ai.engine import PydanticAIEngine
from pydantic_ai_harness import FileSystem, Skills

__all__ = [
    "PydanticAIEngine",
    "FileSystem",
    "Skills",
]
