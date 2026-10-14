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
        raise HTTPException(400, '个人外观接口不接受身份或项目参数')
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
        raise HTTPException(503, '个人外观设置暂时无法读写，请重试') from exc
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
        raise HTTPException(403, '需要已认证的网关用户身份')
    if request.headers.get('X-Appearance-Scope') != scope:
        raise HTTPException(409, '个人外观身份已变化，请刷新后重试')
    return await reply(scope, lambda: preferences.update(scope, body.model_dump(exclude_unset=True)))
