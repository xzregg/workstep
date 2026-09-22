"""Package metadata declared by each installable engine adapter."""
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class RuntimePackage:
    name: str
    kind: Literal["pypi", "npm"]
    minimum: str = "0"
    default_version: str | None = None
