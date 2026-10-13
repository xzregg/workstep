"""Default model reference prices for observed usage; immutable event snapshots."""
import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select

from gateway.contracts import GatewayCall
from gateway.models import AuditEvent, PlatformSetting, UsageEvent
from gateway.services.errors import GatewayError
from gateway.services.identity import COOKIE_NAME
from gateway.services.identity_api import _super_admin_read, _super_admin_request

PRICE_FIELDS = ('input_per_million', 'output_per_million',
                'cache_read_per_million', 'cache_write_per_million')


def price_key(model: str) -> str:
    return 'usage.model_price.' + hashlib.sha256(model.encode()).hexdigest()


class ModelPriceBatch(BaseModel):
    models: list[str] = Field(min_length=1, max_length=100)
    prices: dict[str, str]

    @field_validator('models')
    @classmethod
    def valid_models(cls, models):
        if len(set(models)) != len(models) or any(not model or model != model.strip() or len(model) > 128 for model in models):
            raise ValueError('Invalid model selection')
        return models

    @field_validator('prices')
    @classmethod
    def valid_prices(cls, prices):
        if set(prices) != set(PRICE_FIELDS):
            raise ValueError('Four unit prices required')
        for raw in prices.values():
            if len(raw) > 32:
                raise ValueError('Invalid unit price')
            try: amount = Decimal(raw)
            except InvalidOperation as exc: raise ValueError('Invalid unit price') from exc
            if not amount.is_finite() or not 0 <= amount <= 1000000 or amount.as_tuple().exponent < -8:
                raise ValueError('Invalid unit price')
        return prices


async def observed_model_prices(call: GatewayCall, q: str = '', page: int = 1, page_size: int = 25):
    await _super_admin_read(call)
    conditions = [UsageEvent.model.is_not(None), UsageEvent.model != '']
    if q.strip(): conditions.append(UsageEvent.model.contains(q.strip(), autoescape=True))
    async with call.database.session() as session:
        keys = select(UsageEvent.model).where(*conditions).group_by(UsageEvent.model).subquery()
        total = await session.scalar(select(func.count()).select_from(keys))
        rows = (await session.execute(select(UsageEvent.model, func.count(UsageEvent.id),
            func.sum(UsageEvent.total_tokens), func.max(UsageEvent.occurred_at))
            .where(*conditions).group_by(UsageEvent.model).order_by(UsageEvent.model)
            .offset((page-1)*page_size).limit(page_size))).all()
        settings = (await session.scalars(select(PlatformSetting).where(
            PlatformSetting.key.in_([price_key(row[0]) for row in rows])))).all() if rows else []
    prices = {row.key: json.loads(row.value_json) for row in settings}
    return {'total':total, 'page':page, 'page_size':page_size, 'models':[
        {'model':model, 'event_count':count, 'total_tokens':tokens, 'last_seen_at':last,
         'prices':prices.get(price_key(model), {}).get('prices'),
         'version':prices.get(price_key(model), {}).get('version'), 'currency':'USD'}
        for model,count,tokens,last in rows]}


async def save_model_prices(call: GatewayCall, body: ModelPriceBatch):
    identity, actor = await _super_admin_request(call)
    _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth)
    version = 'model-' + uuid4().hex
    now = datetime.now(timezone.utc)
    async with call.database.session() as session:
        async with session.begin():
            observed = set((await session.scalars(select(UsageEvent.model).where(
                UsageEvent.model.in_(body.models)).distinct())).all())
            if observed != set(body.models):
                raise GatewayError('invalid', 'Only observed models can be priced')
            existing = {row.key:row for row in (await session.scalars(select(PlatformSetting).where(
                PlatformSetting.key.in_([price_key(model) for model in body.models])))).all()}
            for model in body.models:
                key = price_key(model)
                value = json.dumps({'model':model,'prices':body.prices,'version':version,'currency':'USD'})
                row = existing.get(key)
                if row:
                    row.value_json = value; row.updated_by_user_id = actor.id; row.updated_at = now
                else:
                    session.add(PlatformSetting(key=key,value_json=value,updated_by_user_id=actor.id))
            session.add(AuditEvent(id=str(uuid4()),user_id=actor.id,action='admin.model_prices_updated',
                result='success',metadata_json=json.dumps({'models':body.models,'version':version})))
    return {'updated':len(body.models),'version':version}


async def batch_reference_prices(session, models):
    keys = [price_key(model) for model in set(models) if model]
    if not keys: return {}
    rows = (await session.scalars(select(PlatformSetting).where(PlatformSetting.key.in_(keys)))).all()
    return {value['model']:value for value in (json.loads(row.value_json) for row in rows)}


def reference_cost(event, reference):
    if not reference or event.estimated_cost is not None or event.metering_status != 'metered':
        return None
    read, write = event.cache_read_tokens, event.cache_write_tokens
    if read is None or write is None: return None
    if (read or write) and event.cache_input_included is None: return None
    uncached = event.input_tokens
    if event.cache_input_included:
        if read + write > uncached: return None
        uncached -= read + write
    prices = reference['prices']
    amount = sum(Decimal(tokens)*Decimal(prices[field]) for tokens,field in zip(
        (uncached,event.output_tokens,read,write),PRICE_FIELDS)) / Decimal(1000000)
    if amount > Decimal('999999999999'): return None
    return amount.quantize(Decimal('.000001'),rounding=ROUND_HALF_UP)
