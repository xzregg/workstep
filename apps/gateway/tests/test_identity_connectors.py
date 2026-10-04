from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from gateway.services.identity_connectors import DingTalkConnector, WeComConnector
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


@pytest.mark.asyncio
async def test_dingtalk_fetches_all_departments_and_paginated_members(monkeypatch):
    monkeypatch.setenv("WORKSTEP_TEST_DINGTALK_SECRET", "server-secret")
    source = IdentitySource(id="source", provider="dingtalk", tenant_id="corp-a", client_id="app-id",
                            secret_env="WORKSTEP_TEST_DINGTALK_SECRET")
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("/oauth2/accessToken"):
            return httpx.Response(200, json={"accessToken": "app-token"})
        if request.url.path.endswith("/department/listsub"):
            return httpx.Response(200, json={"errcode": 0, "result": [
                {"dept_id": 2, "parent_id": 1, "name": "研发"},
            ] if b'"dept_id":1' in request.content else []})
        if request.url.path.endswith("/user/list"):
            import json
            body = json.loads(request.content)
            if body["dept_id"] == 1:
                return httpx.Response(200, json={"errcode": 0, "result": {"list": [], "has_more": False}})
            if body["cursor"] == 0:
                return httpx.Response(200, json={"errcode": 0, "result": {
                    "list": [{"unionid": "stable-a", "name": "张三", "dept_id_list": [2]}],
                    "has_more": True, "next_cursor": 1,
                }})
            return httpx.Response(200, json={"errcode": 0, "result": {
                "list": [{"unionid": "stable-b", "name": "李四", "dept_id_list": [2]}],
                "has_more": False,
            }})

    connector = DingTalkConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    snapshot = await connector.fetch_directory(source)
    assert {department["external_id"] for department in snapshot["departments"]} == {"1", "2"}
    assert {person["subject"] for person in snapshot["people"]} == {"stable-a", "stable-b"}
    assert all(person["department_ids"] == ["2"] for person in snapshot["people"])
    assert len([request for request in calls if request.url.path.endswith("/user/list")]) == 3


@pytest.mark.asyncio
async def test_wecom_fetches_directory_with_stable_member_ids(monkeypatch):
    monkeypatch.setenv("WORKSTEP_TEST_WECOM_SECRET", "server-secret")
    source = IdentitySource(id="source", provider="wecom", tenant_id="wx-corp", client_id="unused",
                            agent_id="1000001", secret_env="WORKSTEP_TEST_WECOM_SECRET")

    def handler(request):
        if request.url.path.endswith("gettoken"):
            return httpx.Response(200, json={"errcode": 0, "access_token": "app-token"})
        if request.url.path.endswith("department/list"):
            return httpx.Response(200, json={"errcode": 0, "department": [
                {"id": 1, "parentid": 0, "name": "总部"},
                {"id": 2, "parentid": 1, "name": "研发"},
            ]})
        return httpx.Response(200, json={"errcode": 0, "userlist": [
            {"userid": "employee-1", "name": "张三", "department": [2]},
        ]})

    connector = WeComConnector(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    snapshot = await connector.fetch_directory(source)
    assert snapshot["people"] == [{"subject": "employee-1", "display_name": "张三", "department_ids": ["2"]}]
    assert len(snapshot["departments"]) == 2
