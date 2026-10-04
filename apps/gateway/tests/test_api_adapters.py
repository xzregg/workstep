"""Service DTOs preserve API cookie, file and streaming behavior."""

import json
from types import SimpleNamespace

import pytest
from fastapi import Request

from gateway.api.adapters import invoke, render_result
from gateway.contracts import CredentialGrant, GatewayCall, JsonValue, StreamPayload
from gateway.api.errors import gateway_error_response
from gateway.services.errors import GatewayError


async def test_api_passes_plain_values_and_async_payload_to_service():
    async def receive():
        return {"type": "http.request", "body": b"input", "more_body": False}
    request = Request({"type": "http", "method": "POST", "scheme": "https",
        "path": "/action", "query_string": b"tag=one&tag=two",
        "headers": [(b"host", b"gateway.test"), (b"cookie", b"session=secret")],
        "app": SimpleNamespace(state=SimpleNamespace(database="database"))}, receive)

    async def service(call):
        assert isinstance(call, GatewayCall)
        assert not hasattr(call, "app")
        assert call.database == "database"
        assert call.operation == "POST" and call.target.path == "/action"
        assert call.tokens == {"session": "secret"}
        assert call.query_values.multi_items() == (("tag", "one"), ("tag", "two"))
        assert dict(call.query_values) == {"tag": "two"}
        assert await call.read_payload() == b"input"
        return JsonValue({"ok": True})

    response = await invoke(service, request=request)
    assert json.loads(response.body) == {"ok": True}


async def test_stream_adapter_is_lazy_and_preserves_repeated_headers():
    started = False
    async def payload():
        nonlocal started
        started = True
        yield b"chunk"
    value = StreamPayload(payload(), status=206)
    value.headers["content-type"] = "application/octet-stream"
    value.headers.append("set-cookie", "first=1")
    value.headers.append("set-cookie", "second=2")
    response = render_result(value, GatewayCall())
    assert not started
    assert response.status_code == 206
    assert response.headers.getlist("set-cookie") == ["first=1", "second=2"]
    assert [chunk async for chunk in response.body_iterator] == [b"chunk"]


def test_cookie_attributes_are_owned_by_api_adapter():
    value = JsonValue({"ok": True}, grants=[CredentialGrant("session", "secret", 120)])
    response = render_result(value, GatewayCall(settings=SimpleNamespace(cookie_secure=True)))
    cookie = response.headers["set-cookie"]
    assert "session=secret" in cookie
    for attribute in ("Secure", "HttpOnly", "SameSite=lax", "Max-Age=120", "Path=/"):
        assert attribute in cookie


@pytest.mark.parametrize("reason,status", [("bad_input", 400), ("gone", 410),
    ("too_large", 413), ("unsupported", 415), ("rate_limited", 429),
    ("upstream_failed", 502), ("timeout", 504)])
async def test_business_errors_preserve_http_status_and_message(reason, status):
    response = await gateway_error_response(None, GatewayError(reason, "Failure"))
    assert response.status_code == status
    assert json.loads(response.body) == {"error": {"code": "http_error", "message": "Failure"}}
