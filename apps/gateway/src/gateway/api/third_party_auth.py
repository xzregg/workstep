"""ASGI routes for third-party website sign-in."""
from fastapi import APIRouter, Request

from gateway.api.adapters import invoke
from gateway.services import third_party_auth as service
from gateway.services.third_party_auth import AuthorizeInput, CallbackSettingsInput, ExchangeInput

router = APIRouter(prefix='/api')


@router.get('/admin/third-party-auth-settings')
async def get_settings(request: Request):
    return await invoke(service.get_settings, request=request)


@router.put('/admin/third-party-auth-settings')
async def set_settings(request: Request, body: CallbackSettingsInput):
    return await invoke(service.set_settings, request=request, body=body)


@router.post('/auth/third-party/validate')
async def validate(request: Request, body: AuthorizeInput):
    return await invoke(service.validate_authorization, request=request, body=body)


@router.post('/auth/third-party/authorize')
async def authorize(request: Request, body: AuthorizeInput):
    return await invoke(service.authorize, request=request, body=body)


@router.post('/auth/exchange')
async def exchange(request: Request, body: ExchangeInput):
    return await invoke(service.exchange, request=request, body=body)
