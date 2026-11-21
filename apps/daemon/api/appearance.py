"""Read/write only the authenticated user's selection on this device."""

import asyncio

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from services.config import CONFIG_DIR
from services.appearance_preferences import AppearancePatch, AppearancePreferences, identity_scope

router = APIRouter(prefix='/api/appearance')
preferences = AppearancePreferences(CONFIG_DIR / 'runtime' / 'appearance-preferences')


def scope_for(request: Request) -> str | None:
    if request.query_params:
        raise HTTPException(400, 'Personal appearance API does not accept identity or project parameters')
    actor = getattr(request.state, 'managed_actor', None)
    service = getattr(request.app.state, 'gateway_client', None)
    config = getattr(service, 'managed_config', None)
    if actor is None or config is None or request.scope.get('gateway_share_scope') is not None:
        return None
    return identity_scope(config.gateway_id, actor.device_id, actor.user_id)


async def reply(scope, operation):
    try:
        selection = await asyncio.to_thread(operation)
    except OSError as exc:
        raise HTTPException(503, 'Personal appearance settings are temporarily unavailable for read/write operations. Please try again.') from exc
    return JSONResponse({'scope': scope, 'preferences': selection}, headers={'Cache-Control': 'no-store'})


@router.get('/preferences')
async def get_preferences(request: Request):
    scope = scope_for(request)
    if scope is None:
        return JSONResponse({'scope': None, 'preferences': None}, headers={'Cache-Control': 'no-store'})
    return await reply(scope, lambda: preferences.read(scope))


@router.patch('/preferences')
async def patch_preferences(request: Request, body: AppearancePatch):
    scope = scope_for(request)
    if scope is None:
        raise HTTPException(403, 'Authenticated gateway user identity is required')
    if request.headers.get('X-Appearance-Scope') != scope:
        raise HTTPException(409, 'Personal appearance identity has changed, please refresh and try again')
    return await reply(scope, lambda: preferences.update(scope, body.model_dump(exclude_unset=True)))
