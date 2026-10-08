"""HTTP adapters for DingTalk and WeCom QR authorization."""

import os
from collections import deque
from urllib.parse import urlencode

import httpx

from gateway.services.external_identity import ExternalProfile
from gateway.models import IdentitySource


async def _secret(source: IdentitySource, resolver=None) -> str:
    if resolver: return await resolver(source)
    value = os.environ.get(source.secret_env)
    if not value:
        raise ValueError("Identity source secret is unavailable")
    return value


def _checked(response: httpx.Response) -> dict:
    response.raise_for_status()
    data = response.json()
    if data.get("errcode", 0) not in (0, "0"):
        raise ValueError("Directory provider rejected request")
    return data


class DingTalkConnector:
    def __init__(self, client_factory=None, secret_resolver=None):
        self.secret_resolver = secret_resolver
        self.client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=10))

    def authorization_url(self, source: IdentitySource, state: str, nonce: str, redirect_uri: str) -> str:
        query = urlencode({
            "redirect_uri": redirect_uri, "response_type": "code", "client_id": source.client_id,
            "scope": "openid corpid", "state": state, "prompt": "consent",
        })
        return f"https://login.dingtalk.com/oauth2/auth?{query}"

    async def exchange_code(self, source: IdentitySource, code: str, nonce: str) -> ExternalProfile:
        async with self.client_factory() as client:
            token_response = await client.post("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", json={
                "clientId": source.client_id, "clientSecret": await _secret(source, self.secret_resolver),
                "code": code, "grantType": "authorization_code",
            })
            token_response.raise_for_status()
            token = token_response.json()
            if token.get("corpId") != source.tenant_id or not token.get("accessToken"):
                raise ValueError("DingTalk tenant or token mismatch")
            profile_response = await client.get("https://api.dingtalk.com/v1.0/contact/users/me", headers={
                "x-acs-dingtalk-access-token": token["accessToken"],
            })
            profile_response.raise_for_status()
            profile = profile_response.json()
            subject = profile.get("unionId") or profile.get("openId")
            if not subject:
                raise ValueError("DingTalk subject missing")
            return ExternalProfile(
                tenant_id=source.tenant_id, subject=subject,
                display_name=profile.get("nick") or subject,
            )

    async def fetch_directory(self, source: IdentitySource, *, selected_department_ids=None,
                              departments_only=False, progress=None) -> dict:
        async with self.client_factory() as client:
            token = _checked(await client.post("https://api.dingtalk.com/v1.0/oauth2/accessToken", json={
                "appKey": source.client_id, "appSecret": await _secret(source, self.secret_resolver),
            })).get("accessToken")
            if not token:
                raise ValueError("DingTalk app token missing")
            departments = [{"external_id": "1", "display_name": '钉钉组织',
                            "parent_external_id": None}]
            pending = deque([1])
            seen = {1}
            while pending:
                current = pending.popleft()
                children = _checked(await client.post(
                    "https://oapi.dingtalk.com/topapi/v2/department/listsub",
                    params={"access_token": token}, json={"dept_id": current, "language": "zh_CN"},
                )).get("result") or []
                for child in children:
                    department_id = int(child["dept_id"])
                    if department_id in seen:
                        continue
                    if len(seen) >= 10000:
                        raise ValueError("DingTalk directory too large")
                    seen.add(department_id)
                    pending.append(department_id)
                    departments.append({
                        "external_id": str(department_id), "display_name": child["name"],
                        "parent_external_id": str(child["parent_id"]),
                    })
            if departments_only:
                return {"departments": departments, "people": []}
            departments, selected = _selected_departments(departments, selected_department_ids)
            if progress: await progress('fetching', 0, len(selected), None)
            people = {}
            for completed, department_id in enumerate(selected, 1):
                cursor = 0
                for _ in range(10000):
                    page = _checked(await client.post(
                        "https://oapi.dingtalk.com/topapi/v2/user/list",
                        params={"access_token": token},
                        json={"dept_id": department_id, "cursor": cursor, "size": 100,
                              "language": "zh_CN"},
                    )).get("result") or {}
                    for member in page.get("list") or []:
                        subject = member.get("unionid")
                        if not subject:
                            raise ValueError("DingTalk directory member lacks unionid")
                        people[subject] = {
                            "subject": subject, "display_name": member.get("name") or subject,
                            "department_ids": [str(item) for item in member.get("dept_id_list", [])
                                               if str(item) in {str(id) for id in selected}],
                        }
                    if page.get("has_more") not in (True, 1, "true", "True"):
                        break
                    next_cursor = int(page["next_cursor"])
                    if next_cursor <= cursor:
                        raise ValueError("DingTalk cursor did not advance")
                    cursor = next_cursor
                else:
                    raise ValueError("DingTalk member pagination limit reached")
                if progress: await progress('fetching', completed, len(selected), str(department_id))
            return {"departments": departments, "people": list(people.values())}


class WeComConnector:
    def __init__(self, client_factory=None, secret_resolver=None):
        self.secret_resolver = secret_resolver
        self.client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=10))

    def authorization_url(self, source: IdentitySource, state: str, nonce: str, redirect_uri: str) -> str:
        if not source.agent_id:
            raise ValueError("WeCom agent ID required")
        query = urlencode({
            "appid": source.tenant_id, "agentid": source.agent_id,
            "redirect_uri": redirect_uri, "state": state,
        })
        return f"https://open.work.weixin.qq.com/wwopen/sso/qrConnect?{query}"

    async def exchange_code(self, source: IdentitySource, code: str, nonce: str) -> ExternalProfile:
        async with self.client_factory() as client:
            token_response = await client.get("https://qyapi.weixin.qq.com/cgi-bin/gettoken", params={
                "corpid": source.tenant_id, "corpsecret": await _secret(source, self.secret_resolver),
            })
            token_response.raise_for_status()
            token = token_response.json()
            if token.get("errcode") != 0 or not token.get("access_token"):
                raise ValueError("WeCom token exchange failed")
            profile_response = await client.get("https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo", params={
                "access_token": token["access_token"], "code": code,
            })
            profile_response.raise_for_status()
            profile = profile_response.json()
            if profile.get("errcode") != 0 or not profile.get("UserId"):
                raise ValueError("WeCom member identity missing")
            subject = profile["UserId"]
            return ExternalProfile(tenant_id=source.tenant_id, subject=subject, display_name=subject)

    async def fetch_directory(self, source: IdentitySource, *, selected_department_ids=None,
                              departments_only=False, progress=None) -> dict:
        async with self.client_factory() as client:
            token = _checked(await client.get("https://qyapi.weixin.qq.com/cgi-bin/gettoken", params={
                "corpid": source.tenant_id, "corpsecret": await _secret(source, self.secret_resolver),
            })).get("access_token")
            if not token:
                raise ValueError("WeCom app token missing")
            raw_departments = _checked(await client.get(
                "https://qyapi.weixin.qq.com/cgi-bin/department/list",
                params={"access_token": token},
            )).get("department") or []
            if not raw_departments:
                raise ValueError("WeCom directory has no visible departments")
            known = {int(item["id"]) for item in raw_departments}
            departments = [{
                "external_id": str(item["id"]), "display_name": item["name"],
                "parent_external_id": str(item["parentid"]) if int(item["parentid"]) in known else None,
            } for item in raw_departments]
            if departments_only:
                return {"departments": departments, "people": []}
            departments, selected = _selected_departments(departments, selected_department_ids)
            if progress: await progress('fetching', 0, len(selected), None)
            people = {}
            for completed, department_id in enumerate(selected, 1):
                members = _checked(await client.get(
                    "https://qyapi.weixin.qq.com/cgi-bin/user/list",
                    params={"access_token": token, "department_id": department_id,
                            "fetch_child": 0},
                )).get("userlist") or []
                for member in members:
                    subject = member.get("userid")
                    if not subject:
                        raise ValueError("WeCom directory member lacks userid")
                    people[subject] = {
                        "subject": subject, "display_name": member.get("name") or subject,
                        "department_ids": [str(item) for item in member.get("department", [])
                                           if str(item) in {str(id) for id in selected}],
                    }
                if progress: await progress('fetching', completed, len(selected), str(department_id))
            return {"departments": departments, "people": list(people.values())}


def _selected_departments(departments, selected_department_ids):
    known = {item['external_id'] for item in departments}
    selected = known if selected_department_ids is None else set(selected_department_ids)
    if not selected or not selected <= known:
        raise ValueError('Selected department is unavailable')
    filtered = [{**item, 'parent_external_id': item.get('parent_external_id')
                 if item.get('parent_external_id') in selected else None}
                for item in departments if item['external_id'] in selected]
    return filtered, [int(item['external_id']) for item in filtered]
