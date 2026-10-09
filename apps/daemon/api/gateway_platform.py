"""Browser settings and callback for desktop and mobile Gateway configuration."""
import httpx
import os
import hmac
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator
from services.gateway_client.browser_login import COOKIE, normalize_origin

router = APIRouter()


class LoginInput(BaseModel):
    url: str = Field(min_length=1, max_length=2048)

    @field_validator('url')
    @classmethod
    def valid_url(cls, value): return normalize_origin(value)


class SettingsInput(BaseModel):
    url: str = Field(max_length=2048)
    enabled: bool = False

    @field_validator('url')
    @classmethod
    def valid_url(cls, value): return normalize_origin(value) if value.strip() else ''


def _settings_service(request: Request, mutation=False, configure=False):
    actor = request.scope.get('gateway_remote_actor')
    if request.scope.get('gateway_share_scope') is not None or (actor is not None and actor.project_id is not None):
        raise HTTPException(status_code=403, detail='Gateway settings require host access')
    if mutation and request.headers.get('origin') != str(request.base_url).rstrip('/'):
        raise HTTPException(status_code=403, detail='Same-origin request required')
    gateway = getattr(request.app.state, 'gateway_client', None)
    local = actor is None and request.client and request.client.host in ('127.0.0.1', '::1', 'localhost') and request.url.hostname in ('127.0.0.1', '::1', 'localhost')
    if configure and gateway is not None and gateway.managed_config is not None and not local and not _desktop(request):
        actor = actor or gateway.local_sessions.resolve(request.headers.get('x-workstep-local-session') or request.cookies.get(COOKIE))
        if actor is None or actor.user_id != gateway.current_user_id:
            raise HTTPException(status_code=403, detail='Gateway settings require the device owner session')
    return request.app.state.gateway_browser_login


def _desktop(request: Request) -> bool:
    expected = os.environ.get('WORKSTEP_DESKTOP_TOKEN')
    return bool(os.environ.get('WORKSTEP_DESKTOP_RUNTIME') == '1' and expected and
        hmac.compare_digest(request.headers.get('x-workstep-desktop-token', ''), expected))


def _desktop_login_handoff(request: Request) -> bool:
    """Use the app handoff for Electron's authenticated UI or its local browser."""
    if _desktop(request):
        return True
    loopback = ('127.0.0.1', '::1', 'localhost')
    return bool(os.environ.get('WORKSTEP_DESKTOP_RUNTIME') == '1' and request.client
        and request.client.host in loopback and request.url.hostname in loopback)


@router.get('/api/gateway-platform/settings')
async def settings(request: Request):
    return await _settings_service(request).settings()


@router.put('/api/gateway-platform/settings')
async def save_settings(request: Request, body: SettingsInput):
    service = _settings_service(request, mutation=True, configure=True)
    try:
        return await service.save_settings(body.url, body.enabled)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/api/gateway-platform/login')
async def login(request: Request, body: LoginInput):
    service = _settings_service(request, mutation=True)
    try:
        url = await service.begin(body.url, str(request.base_url).rstrip('/'), desktop=_desktop_login_handoff(request))
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail='Invalid platform configuration or changed signing key') from exc
    except (OSError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=502, detail='Gateway unavailable') from exc
    return {'authorization_url': url}


@router.get('/gateway/login', include_in_schema=False)
async def reopen_login(request: Request):
    service = _settings_service(request)
    configured = await service.settings()
    if not configured['url'] or not configured['enabled']: return RedirectResponse('/', status_code=303)
    try:
        return RedirectResponse(await service.begin(configured['url'], str(request.base_url).rstrip('/'), desktop=_desktop(request)), status_code=303)
    except (ValueError, KeyError, OSError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=502, detail='Unable to start Gateway login') from exc


@router.post('/api/gateway-platform/logout')
async def logout(request: Request):
    service = _settings_service(request, mutation=True, configure=True)
    await service.logout()
    from fastapi.responses import JSONResponse
    response = JSONResponse({'login_url': '/gateway/login'})
    response.delete_cookie(COOKIE, path='/')
    return response


@router.get('/api/gateway-platform/callback', include_in_schema=False)
async def callback(request: Request, code: str = Query(min_length=32, max_length=256), state: str = Query(min_length=32, max_length=256)):
    service = _settings_service(request)
    try:
        result = await service.complete(code, state, callback_origin=str(request.base_url).rstrip('/'))
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail='Gateway login expired or invalid') from exc
    except httpx.HTTPStatusError as exc:
        if 400 <= exc.response.status_code < 500:
            try:
                body = exc.response.json()
                error = body.get('error') if isinstance(body, dict) else None
                message = error.get('message') if isinstance(error, dict) else None
                if not isinstance(message, str): message = None
            except ValueError:
                message = None
            detail = {
                'Device unavailable': '此设备已被网关停用或撤销，请联系网关管理员处理设备授权。',
                'User device access revoked': '网关已撤销此账号的设备访问权限，请联系网关管理员。',
                'Account unavailable': '网关账号不可用，请联系网关管理员。',
                'Desktop authorization mismatch': '网关授权校验失败，请重新打开认证窗口登录。',
                'Desktop code already used': '此次授权已被使用，请重新打开认证窗口登录。',
                'Desktop code expired': '此次授权已过期，请重新打开认证窗口登录。',
                'Old device key proof required': '设备身份密钥已变化，请联系网关管理员处理设备授权。',
            }.get(message, '网关拒绝了本次登录，请重新认证或联系网关管理员。')
            raise HTTPException(status_code=exc.response.status_code, detail=detail) from exc
        raise HTTPException(status_code=502, detail='Gateway unavailable; retry login') from exc
    except (OSError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=502, detail='Gateway unavailable; retry login') from exc
    desktop = bool(result and len(result) > 2 and result[2])
    response = RedirectResponse('workstep://open' if desktop else '/?gateway_auth=' + ('complete' if result else 'pending'), status_code=303)
    if result:
        token, _actor = result[:2]
        # Cross-site Gateway -> daemon redirects must carry the session on the
        # top-level GET; writes and WebSockets enforce their own Origin checks.
        response.set_cookie(COOKIE, token, httponly=True, samesite='strict' if desktop else 'lax', secure=request.url.scheme=='https', path='/')
    return response
