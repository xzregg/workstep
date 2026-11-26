"""Optional native engine login contract. Secrets never belong in snapshots."""
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from uuid import uuid4


@dataclass
class EngineLoginState:
    id: str = field(default_factory=lambda: uuid4().hex)
    phase: str = 'starting'
    authorization_url: str | None = None
    error: str | None = None

    @property
    def active(self):
        return self.phase in ('starting', 'waiting_code', 'submitting')


class EngineLoginSession(ABC):
    def __init__(self):
        self.state = EngineLoginState()

    def snapshot(self):
        return asdict(self.state)

    @abstractmethod
    async def start(self): ...

    @abstractmethod
    async def submit(self, code: str): ...

    @abstractmethod
    async def cancel(self): ...
