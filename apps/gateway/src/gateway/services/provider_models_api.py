"""Super-admin discovery and selection of the model catalog distributed to PCs."""

import asyncio
import json
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import httpx
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import update

from gateway.contracts import GatewayCall, JsonValue
from gateway.models import AuditEvent, Device, PlatformProvider
from gateway.services.errors import GatewayError
from gateway.services.providers_api import _admin, _public_provider

MAX_MODELS = 1000
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
DISCOVERY_ERROR = '读取模型列表失败，请检查供应商地址与凭据。'


class ProviderModelsInput(BaseModel):
    revision: int = Field(ge=1)
    models: list[str] = Field(max_length=MAX_MODELS)

    @field_validator('models')
    @classmethod
    def valid_models(cls, values):
        if len(set(values)) != len(values) or any(
            not value or value != value.strip() or len(value) > 128 for value in values
        ):
            raise ValueError('Invalid provider models')
        return values


def _client():
    return httpx.AsyncClient(timeout=15, follow_redirects=False, trust_env=False)


async def _read_models(client, url, headers, anthropic):
    models = []
    after = None
    for _ in range(10):
        params = {'limit': '100', **({'after_id': after} if after else {})} if anthropic else {}
        async with client.stream('GET', url, headers=headers, params=params) as response:
            response.raise_for_status()
            content = bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > MAX_RESPONSE_BYTES:
                    raise ValueError('Model response too large')
        data = json.loads(content)
        if not isinstance(data, dict):
            raise ValueError('Invalid model response')
        rows = data.get('data')
        if not isinstance(rows, list):
            raise ValueError('Invalid model response')
        for row in rows:
            model = row.get('id') if isinstance(row, dict) else None
            if not isinstance(model, str) or not model or model != model.strip() or len(model) > 128:
                raise ValueError('Invalid model id')
            if model not in models:
                models.append(model)
            if len(models) > MAX_MODELS:
                raise ValueError('Too many models')
        if not anthropic or not data.get('has_more'):
            return models
        next_after = data.get('last_id')
        if not isinstance(next_after, str) or not next_after or next_after == after:
            raise ValueError('Invalid pagination')
        after = next_after
    raise ValueError('Too many model pages')


async def discover_models(config, secret):
    models = set()
    errors = []
    fetched = {}
    async with _client() as client:
        for protocol in config['protocols']:
            anthropic = protocol == 'anthropic_messages'
            parts = urlsplit(config['protocol_base_urls'][protocol])
            path = parts.path.rstrip('/')
            if anthropic and not path.endswith('/v1'):
                path += '/v1'
            url = urlunsplit((parts.scheme, parts.netloc, path + '/models', parts.query, ''))
            cache_key = (url, anthropic)
            if cache_key not in fetched:
                headers = {'x-api-key': secret, 'anthropic-version': '2023-06-01'} if anthropic else {
                    'Authorization': f'Bearer {secret}',
                }
                try:
                    fetched[cache_key] = await asyncio.wait_for(
                        _read_models(client, url, headers, anthropic), timeout=15,
                    )
                except (httpx.HTTPError, ValueError, TypeError, asyncio.TimeoutError):
                    fetched[cache_key] = None
            found = fetched[cache_key]
            if found is None or len(models | set(found)) > MAX_MODELS:
                errors.append({'protocol': protocol, 'error': DISCOVERY_ERROR})
            else:
                models.update(found)
    return {'models': [{'id': model} for model in sorted(models)], 'errors': errors}


async def preview_platform_provider_models(call: GatewayCall, provider_id: str):
    await _admin(call)
    async with call.database.session() as session:
        provider = await session.get(PlatformProvider, provider_id)
        if provider is None or not provider.enabled:
            raise GatewayError('not_found', 'Provider unavailable')
        revision, ciphertext = provider.revision, provider.secret_ciphertext
        config = json.loads(provider.config_json)
    secret = await asyncio.to_thread(call.gateway_signer.decrypt_provider_secret, provider_id, ciphertext)
    result = await discover_models(config, secret)
    async with call.database.session() as session:
        current = await session.get(PlatformProvider, provider_id)
        if current is None or not current.enabled or current.revision != revision:
            raise GatewayError('conflict', 'Provider changed; reload before retrying')
    return JsonValue({'revision': revision, **result}, headers={'Cache-Control': 'no-store'})


async def select_platform_provider_models(call: GatewayCall, provider_id: str, body: ProviderModelsInput):
    actor = await _admin(call)
    async with call.database.session() as session:
        async with session.begin():
            provider = await session.get(PlatformProvider, provider_id)
            if provider is None or not provider.enabled:
                raise GatewayError('not_found', 'Provider unavailable')
            prices = json.loads(provider.prices_json)
            prices['models'] = {key: value for key, value in prices.get('models', {}).items() if key in body.models}
            changed = await session.execute(update(PlatformProvider).where(
                PlatformProvider.id == provider_id, PlatformProvider.revision == body.revision,
                PlatformProvider.enabled == 1,
            ).values(models_json=json.dumps(body.models), prices_json=json.dumps(prices),
                     revision=PlatformProvider.revision + 1))
            if changed.rowcount != 1:
                raise GatewayError('conflict', 'Provider changed; reload before retrying')
            await session.execute(update(Device).where(Device.status == 'active').values(
                provider_revision=Device.provider_revision + 1, policy_revision=Device.policy_revision + 1,
            ))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, action='admin.provider_models_selected',
                                   result='success', metadata_json=json.dumps({'provider_id': provider_id,
                                   'revision': body.revision + 1, 'model_count': len(body.models)})))
            await session.refresh(provider)
            result = _public_provider(provider)
    return result
