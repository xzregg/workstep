"""Map business failures to the public HTTP error contract."""

from fastapi import Request
from fastapi.responses import JSONResponse

from http import HTTPStatus

from gateway.services.errors import GatewayError
from gateway.services.identity_errors import IdentityError

_IDENTITY_STATUS = {
    "bad_input": 400, "gone": 410, "too_large": 413, "unsupported": 415,
    "rate_limited": 429, "upstream_failed": 502, "timeout": 504,
    "unauthenticated": 401,
    "forbidden": 403,
    "not_found": 404,
    "conflict": 409,
    "invalid": 422,
    "unavailable": 503,
}


async def identity_error_response(_request: Request, exc: IdentityError) -> JSONResponse:
    status = _IDENTITY_STATUS[exc.reason]
    return JSONResponse(status_code=status, content={"error": {
        "code": "not_found" if status == 404 else "http_error",
        "message": exc.message,
    }})


async def gateway_error_response(request: Request, exc: GatewayError) -> JSONResponse:
    status = _IDENTITY_STATUS[exc.reason]
    return JSONResponse(status_code=status, content={"error": {
        "code": "not_found" if status == 404 else "http_error",
        "message": exc.message if exc.message is not None else HTTPStatus(status).phrase,
    }})
