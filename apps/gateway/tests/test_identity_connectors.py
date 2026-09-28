from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from gateway.identity_connectors import DingTalkConnector, WeComConnector
from gateway.models import IdentitySource


@pytest.mark.asyncio
async def test_dingtalk_exchange_checks_corporation_and_uses_stable_union_id(monkeypatch):
    monkeypatch.setenv("WORKSTEP_TEST_DINGTALK_SECRET", "server-secret")
    source = IdentitySource(id="source", provider="dingtalk", tenant_id="corp-a", client_id="app-id",
                            secret_env="WORKSTEP_TEST_DINGTALK_SECRET")
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("userAccessToken"):
            return httpx.Response(200, json={"corpId": "corp-a", "accessToken": "user-token"})
        return httpx.Response(200, json={"unionId": "stable-123", "nick": "张三"})

    connector = DingTalkConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    url = connector.authorization_url(source, "state-1", "nonce-1", "https://gateway.test/callback")
    assert parse_qs(urlparse(url).query)["state"] == ["state-1"]
    profile = await connector.exchange_code(source, "one-time-code", "nonce-1")
    assert (profile.tenant_id, profile.subject, profile.display_name) == ("corp-a", "stable-123", "张三")
    assert len(requests) == 2
    assert b"server-secret" in requests[0].content

    def wrong_tenant(request):
        return httpx.Response(200, json={"corpId": "corp-b", "accessToken": "user-token"})

    connector = DingTalkConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(wrong_tenant)))
    with pytest.raises(ValueError, match="tenant"):
        await connector.exchange_code(source, "one-time-code", "nonce-1")


@pytest.mark.asyncio
async def test_wecom_exchange_accepts_only_enterprise_member(monkeypatch):
    monkeypatch.setenv("WORKSTEP_TEST_WECOM_SECRET", "server-secret")
    source = IdentitySource(id="source", provider="wecom", tenant_id="wx-corp", client_id="unused",
                            agent_id="1000001", secret_env="WORKSTEP_TEST_WECOM_SECRET")

    def handler(request):
        if request.url.path.endswith("gettoken"):
            assert request.url.params["corpid"] == "wx-corp"
            return httpx.Response(200, json={"errcode": 0, "access_token": "app-token"})
        return httpx.Response(200, json={"errcode": 0, "UserId": "employee-1"})

    connector = WeComConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    url = connector.authorization_url(source, "state-1", "nonce-1", "https://gateway.test/callback")
    assert parse_qs(urlparse(url).query)["appid"] == ["wx-corp"]
    assert (await connector.exchange_code(source, "one-time-code", "nonce-1")).subject == "employee-1"

    def outsider(request):
        if request.url.path.endswith("gettoken"):
            return httpx.Response(200, json={"errcode": 0, "access_token": "app-token"})
        return httpx.Response(200, json={"errcode": 0, "OpenId": "outside-user"})

    connector = WeComConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(outsider)))
    with pytest.raises(ValueError, match="member"):
        await connector.exchange_code(source, "one-time-code", "nonce-1")
