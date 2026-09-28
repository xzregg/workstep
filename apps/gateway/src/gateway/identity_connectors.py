"""HTTP adapters for DingTalk and WeCom QR authorization."""

import os
from urllib.parse import urlencode

import httpx

from .external_identity import ExternalProfile
from .models import IdentitySource


def _secret(source: IdentitySource) -> str:
    value = os.environ.get(source.secret_env)
    if not value:
        raise ValueError("Identity source secret is unavailable")
    return value


class DingTalkConnector:
    def __init__(self, client_factory=None):
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
                "clientId": source.client_id, "clientSecret": _secret(source),
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


class WeComConnector:
    def __init__(self, client_factory=None):
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
                "corpid": source.tenant_id, "corpsecret": _secret(source),
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
