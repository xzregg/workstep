"""Account quota contract. Collection and authentication belong to each engine."""
import asyncio
import time
from typing import Annotated, Literal, TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field, model_validator

if TYPE_CHECKING:
    from engines.core.base import BaseLLMEngine

Percent = Annotated[float, Field(strict=True, ge=0, le=100, allow_inf_nan=False)]
NonNegative = Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)]


class QuotaAuthenticationRequired(Exception):
    """The engine requires account authentication before reading quota."""


class QuotaWindow(BaseModel):
    used_percent: NonNegative
    remaining_percent: Percent
    resets_at: NonNegative | None = None  # Unix epoch seconds
    window_duration_mins: NonNegative | None = None
    kind: str | None = None
    label: str | None = None

    @model_validator(mode='before')
    @classmethod
    def complete_percentages(cls, value):
        if not isinstance(value, dict):
            return value
        value = dict(value)
        used, remaining = value.get('used_percent'), value.get('remaining_percent')
        if used is None and isinstance(remaining, (int, float)) and not isinstance(remaining, bool):
            value['used_percent'] = round(100 - remaining, 10)
        elif remaining is None and isinstance(used, (int, float)) and not isinstance(used, bool):
            value['remaining_percent'] = round(max(0, 100 - used), 10)
        return value

    @model_validator(mode='after')
    def consistent_percentages(self):
        if abs(self.remaining_percent - max(0, 100 - self.used_percent)) > .1:
            raise ValueError('Inconsistent quota percentages')
        return self


class QuotaGroup(BaseModel):
    name: str = Field(min_length=1)
    windows: list[QuotaWindow] = Field(min_length=1)


class QuotaCredits(BaseModel):
    model_config = ConfigDict(coerce_numbers_to_str=True)
    balance: str | None = None
    has_credits: bool | None = None
    unlimited: bool = False
    unit: str | None = None


class QuotaIndividualLimit(BaseModel):
    model_config = ConfigDict(coerce_numbers_to_str=True)
    limit: str
    used: str
    remaining_percent: Percent
    resets_at: NonNegative | None = None


class EngineQuota(BaseModel):
    """Public snapshot; unknown adapter fields are never projected to clients."""
    engine_id: str = ''
    limit_name: str | None = None
    limit_id: str | None = None
    plan_type: str | None = None
    primary: QuotaWindow | None = None
    secondary: QuotaWindow | None = None
    groups: list[QuotaGroup] = Field(default_factory=list)
    credits: QuotaCredits | None = None
    individual_limit: QuotaIndividualLimit | None = None
    collected_at: NonNegative = Field(default_factory=time.time)

    @model_validator(mode='after')
    def choose_primary(self):
        if self.primary is None:
            windows = [window for group in self.groups for window in group.windows]
            if self.secondary is not None:
                windows.append(self.secondary)
            if windows:
                self.primary = min(windows, key=lambda window: window.remaining_percent)
        if self.credits is not None and self.credits.balance is None and not self.credits.unlimited:
            self.credits = None
        if self.primary is None and self.credits is None and self.individual_limit is None:
            raise ValueError('No account quota data')
        return self


class EngineQuotaResult(BaseModel):
    engine_id: str
    supported: bool
    status: Literal['ok', 'unsupported', 'unauthenticated', 'unavailable']
    quota: EngineQuota | None = None


async def query_quota(engine: 'BaseLLMEngine', cwd: str, *, timeout: float = 20) -> dict:
    """Bound collection, normalize public data, and keep cancellation observable.

    None from a supported adapter means temporarily unavailable, never unsupported.
    Adapters must use asynchronous I/O and clean up their own processes on cancel.
    """
    result = EngineQuotaResult(
        engine_id=engine.ENGINE_ID, supported=engine.supports_quota,
        status='unavailable' if engine.supports_quota else 'unsupported',
    )
    if result.supported:
        try:
            async with asyncio.timeout(timeout):
                snapshot = await engine.get_quota(cwd=cwd)
            if snapshot is not None:
                quota = EngineQuota.model_validate(snapshot)
                quota.engine_id = engine.ENGINE_ID
                result.quota, result.status = quota, 'ok'
        except QuotaAuthenticationRequired:
            result.status = 'unauthenticated'
        except Exception:
            # SDK errors can contain tokens, endpoints or account identifiers.
            # Do not expose or log arbitrary adapter diagnostics here.
            result.status = 'unavailable'
    data = result.model_dump(mode='json', exclude_none=True)
    if result.quota is None:
        data['quota'] = None
    return data
