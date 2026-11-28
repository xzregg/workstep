"""Browser settings and callback for desktop and mobile Gateway configuration."""
import httpx
from urllib.parse import urlsplit
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator
from services.gateway_client.browser_login import GatewayLoginError, local_session_cookie_name, normalize_origin
from api.desktop_security import (browser_origin_allowed, local_gateway_fallback_allowed,
    gateway_workspace_access_allowed, local_gateway_workspace_active, set_local_gateway_workspace_cookie,
    )
from api.workspace_access import require_workspace_access, require_same_origin, desktop_login_handoff
from api.workspace_access import is_desktop_client as _desktop

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


class ResetTrustInput(LoginInput):
    fingerprint: str = Field(min_length=64, max_length=64, pattern='^[0-9a-f]{64}$')


def _login_error(exc):
    detail = {}
    if isinstance(exc, GatewayLoginError):
        code = exc.code
        status = 409 if code in ('gateway_key_changed', 'gateway_settings_changed') else 400
        if exc.fingerprint:
            detail['fingerprint'] = exc.fingerprint
    elif isinstance(exc, httpx.TimeoutException):
        code, status = 'gateway_timeout', 502
    elif isinstance(exc, httpx.HTTPStatusError):
        code, status = 'gateway_http_error', 502
        detail['status'] = exc.response.status_code
    elif isinstance(exc, (OSError, httpx.HTTPError)):
        code, status = 'gateway_unreachable', 502
    else:
        code, status = 'gateway_invalid_response', 400
    return HTTPException(status_code=status, detail={'code': code, **detail})


async def _settings_service(request: Request, mutation=False, configure=False):
    await require_workspace_access(request, 'gateway_configuration' if configure else 'scope', detail='Gateway settings require host access')
    if mutation:
        require_same_origin(request)
    return request.app.state.gateway_browser_login


def _desktop_login_handoff(request: Request) -> bool:
    return desktop_login_handoff(request)


def _browser_callback_origin(request: Request, service=None) -> str:
    """Use the public browser scheme when TLS terminates before the daemon.

    The login POST supplies a same-authority Origin checked by the mutation
    guard. The cross-site callback has no Origin, so use the origin saved with
    that pending login only when its authority matches the incoming Host.
    """
    internal = str(request.base_url).rstrip('/')
    browser = request.headers.get('origin')
    if browser and browser_origin_allowed(request):
        return browser
    pending = getattr(service, 'pending', None)
    expected = pending.get('callback_origin') if isinstance(pending, dict) else None
    if (expected and request.url.scheme == 'http'
            and urlsplit(expected).scheme == 'https'
            and urlsplit(expected).netloc == request.url.netloc):
        return expected
    return internal


@router.get('/api/gateway-platform/settings')
async def settings(request: Request):
    return {**await (await _settings_service(request)).settings(),
            'local_workspace': await local_gateway_workspace_active(request)}


@router.post('/api/gateway-platform/local-workspace')
async def local_workspace(request: Request):
    await _settings_service(request, mutation=True)
    if not await gateway_workspace_access_allowed(request):
        raise HTTPException(status_code=403, detail='Local workspace requires local device access')
    from fastapi.responses import JSONResponse
    return set_local_gateway_workspace_cookie(request, JSONResponse({'local_workspace': True}))


@router.put('/api/gateway-platform/settings')
async def save_settings(request: Request, body: SettingsInput):
    service = await _settings_service(request, mutation=True, configure=True)
    try:
        return await service.save_settings(body.url, body.enabled)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post('/api/gateway-platform/login')
async def login(request: Request, body: LoginInput):
    service = await _settings_service(request, mutation=True)
    try:
        url = await service.begin(body.url, _browser_callback_origin(request), desktop=_desktop_login_handoff(request))
    except (ValueError, KeyError, TypeError, OSError, httpx.HTTPError) as exc:
        raise _login_error(exc) from exc
    return {'authorization_url': url}


@router.post('/api/gateway-platform/reset-trust')
async def reset_trust(request: Request, body: ResetTrustInput):
    service = await _settings_service(request, mutation=True, configure=True)
    try:
        return await service.reset_trust(body.url, body.fingerprint)
    except (ValueError, OSError) as exc:
        raise _login_error(exc) from exc


@router.get('/gateway/login', include_in_schema=False)
async def reopen_login(request: Request):
    service = await _settings_service(request)
    configured = await service.settings()
    if not configured['url'] or not configured['enabled']: return RedirectResponse('/', status_code=303)
    try:
        return RedirectResponse(await service.begin(configured['url'], _browser_callback_origin(request), desktop=_desktop(request)), status_code=303)
    except (ValueError, KeyError, OSError, httpx.HTTPError) as exc:
        if local_gateway_fallback_allowed(request):
            return RedirectResponse('/?gateway_auth=cancelled', status_code=303,
                headers={'Cache-Control': 'no-store'})
        raise HTTPException(status_code=502, detail='Unable to start Gateway login') from exc


@router.post('/api/gateway-platform/logout')
async def logout(request: Request):
    service = await _settings_service(request, mutation=True, configure=True)
    await service.logout()
    from fastapi.responses import JSONResponse
    response = JSONResponse({'login_url': '/gateway/login'})
    response.delete_cookie(local_session_cookie_name(request.app), path='/')
    return response


@router.get('/api/gateway-platform/callback', include_in_schema=False)
async def callback(request: Request, code: str = Query(min_length=32, max_length=256), state: str = Query(min_length=32, max_length=256)):
    service = await _settings_service(request)
    callback_origin = _browser_callback_origin(request, service)
    try:
        result = await service.complete(code, state, callback_origin=callback_origin)
    except (ValueError, KeyError) as exc:
        if request.headers.get('sec-fetch-mode') == 'navigate' or 'text/html' in request.headers.get('accept', ''):
            # A browser must start a fresh PKCE request instead of retrying the
            # expired callback. Native code exchange still needs an error status.
            return RedirectResponse('/gateway/login', status_code=303, headers={'Cache-Control': 'no-store'})
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
        response.delete_cookie(local_session_cookie_name(request.app) + '_workspace', path='/')
        token, _actor = result[:2]
        # Cross-site Gateway -> daemon redirects must carry the session on the
        # top-level GET; writes and WebSockets enforce their own Origin checks.
        response.set_cookie(local_session_cookie_name(request.app), token, httponly=True, samesite='strict' if desktop else 'lax',
                            secure=callback_origin.startswith('https://'), path='/')
    return response
