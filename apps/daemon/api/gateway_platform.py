"""Local settings and browser callback for a configurable platform connection."""
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


def _local(request: Request, mutation=False):
    if (request.scope.get('gateway_remote_actor') is not None or not request.client or request.client.host not in ('127.0.0.1', '::1', 'localhost')
            or request.url.hostname not in ('127.0.0.1', '::1', 'localhost')):
        raise HTTPException(status_code=403, detail='Local platform settings only')
    if mutation and request.headers.get('origin') != str(request.base_url).rstrip('/'):
        raise HTTPException(status_code=403, detail='Same-origin request required')
    return request.app.state.gateway_browser_login


def _desktop(request: Request) -> bool:
    expected = os.environ.get('WORKSTEP_DESKTOP_TOKEN')
    return bool(os.environ.get('WORKSTEP_DESKTOP_RUNTIME') == '1' and expected and
        hmac.compare_digest(request.headers.get('x-workstep-desktop-token', ''), expected))


@router.get('/api/gateway-platform/settings')
async def settings(request: Request):
    return await _local(request).settings()


@router.post('/api/gateway-platform/login')
async def login(request: Request, body: LoginInput):
    service = _local(request, mutation=True)
    try:
        url = await service.begin(body.url, str(request.base_url).rstrip('/'), desktop=_desktop(request))
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail='Invalid platform configuration or changed signing key') from exc
    except (OSError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=502, detail='Gateway unavailable') from exc
    return {'authorization_url': url}


@router.get('/gateway/login', include_in_schema=False)
async def reopen_login(request: Request):
    service = _local(request)
    configured = await service.settings()
    if not configured['url']: return RedirectResponse('/', status_code=303)
    try:
        return RedirectResponse(await service.begin(configured['url'], str(request.base_url).rstrip('/'), desktop=_desktop(request)), status_code=303)
    except (ValueError, KeyError, OSError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=502, detail='Unable to start Gateway login') from exc


@router.get('/api/gateway-platform/callback', include_in_schema=False)
async def callback(request: Request, code: str = Query(min_length=32, max_length=256), state: str = Query(min_length=32, max_length=256)):
    service = _local(request)
    try:
        result = await service.complete(code, state)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail='Gateway login expired or invalid') from exc
    except (OSError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=502, detail='Gateway unavailable; retry login') from exc
    response = RedirectResponse('/?gateway_auth=' + ('complete' if result else 'pending'), status_code=303)
    if result:
        token, _actor = result
        response.set_cookie(COOKIE, token, httponly=True, samesite='strict', secure=request.url.scheme=='https', path='/')
    return response
