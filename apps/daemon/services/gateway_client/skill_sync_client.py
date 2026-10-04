"""Verify signed Skill manifests and fetch only authorized packages."""

import asyncio
import base64
import binascii
import hashlib
import json
import re
import time
from pathlib import Path

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .skill_sync import MAX_ARCHIVE_BYTES, apply_project_skills, project_needs_sync


def _decode(value: str) -> bytes:
    if (not isinstance(value, str) or not value or len(value) > 750 * 1024
            or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
                   for char in value)):
        raise ValueError("Invalid Skill manifest encoding")
    return base64.urlsafe_b64decode(value + "===")


def verify_skill_manifest(token: str, public_key_pem: str, expected_fingerprint: str,
                          gateway_id: str, device_id: str, user_id: str) -> list[dict]:
    try:
        if not isinstance(token, str) or len(token) > 750 * 1024:
            raise ValueError("Skill manifest too large")
        key = serialization.load_pem_public_key(public_key_pem.encode())
        if not isinstance(key, Ed25519PublicKey):
            raise ValueError("Gateway Skill key must be Ed25519")
        fingerprint = hashlib.sha256(key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
        if fingerprint != expected_fingerprint:
            raise ValueError("Gateway Skill key mismatch")
        header, payload, signature = token.split(".")
        if json.loads(_decode(header)) != {"alg": "EdDSA", "typ": "JWT"}:
            raise ValueError("Invalid Skill manifest algorithm")
        key.verify(_decode(signature), f"{header}.{payload}".encode())
        claims = json.loads(_decode(payload))
        now = int(time.time())
        if not isinstance(claims, dict):
            raise ValueError("Invalid Skill manifest claims")
        projects = claims.get("projects")
        if (claims.get("kind") != "skill.manifest"
                or claims.get("iss") != gateway_id or claims.get("gateway_id") != gateway_id
                or claims.get("device_id") != device_id or claims.get("user_id") != user_id
                or type(claims.get("iat")) is not int or type(claims.get("exp")) is not int
                or claims["iat"] > now + 60 or claims["exp"] <= now
                or claims["exp"] - claims["iat"] > 600
                or not isinstance(projects, list) or len(projects) > 1000):
            raise ValueError("Invalid Skill manifest scope")
        seen = set()
        for project in projects:
            if (not isinstance(project, dict)
                    or not isinstance(project.get("platform_project_id"), str)
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}",
                                        project["platform_project_id"])
                    or not isinstance(project.get("host_project_id"), str)
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}",
                                        project["host_project_id"])
                    or type(project.get("revision")) is not int or project["revision"] < 0
                    or not isinstance(project.get("skills"), list)
                    or len(project["skills"]) > 100
                    or project["platform_project_id"] in seen):
                raise ValueError("Invalid Skill project scope")
            seen.add(project["platform_project_id"])
            for skill in project["skills"]:
                if (not isinstance(skill, dict)
                        or not isinstance(skill.get("skill_version_id"), str)
                        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}",
                                            skill["skill_version_id"])):
                    raise ValueError("Invalid Skill version scope")
        return projects
    except (InvalidSignature, KeyError, TypeError, ValueError, UnicodeError,
            json.JSONDecodeError, binascii.Error) as exc:
        raise ValueError("Invalid Gateway Skill manifest") from exc


class ManagedSkillSyncService:
    def __init__(self, origin: str, *, project_lookup, fetcher=None,
                 is_project_busy=None):
        self.origin = origin.rstrip("/")
        self.project_lookup = project_lookup
        self.fetcher = fetcher or self._fetch_archive
        self.is_project_busy = is_project_busy or (lambda _project_id: False)

    async def _fetch_archive(self, version_id: str, token: str) -> bytes:
        url = f"{self.origin}/api/device/skills/{version_id}"
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            async with client.stream("GET", url, headers={
                "Authorization": f"Bearer {token}",
            }) as response:
                response.raise_for_status()
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_ARCHIVE_BYTES:
                        raise ValueError("Skill archive too large")
                return bytes(data)

    async def apply_manifest(self, token: str, public_key_pem: str,
                             expected_fingerprint: str, gateway_id: str,
                             device_id: str, user_id: str) -> list[dict]:
        projects = await asyncio.to_thread(
            verify_skill_manifest, token, public_key_pem,
            expected_fingerprint, gateway_id, device_id, user_id,
        )
        archive_cache: dict[str, bytes] = {}
        results = []
        for project in projects:
            result = {"project_id": project["platform_project_id"],
                      "revision": project["revision"]}
            try:
                local = self.project_lookup(project["host_project_id"])
                if local is None:
                    raise ValueError("project_missing")
                path = Path(local.path)
                if await asyncio.to_thread(project_needs_sync, path, project):
                    if self.is_project_busy(project["host_project_id"]):
                        results.append({**result, "status": "deferred",
                                        "error_code": "busy"})
                        continue
                    for skill in project["skills"]:
                        version_id = skill["skill_version_id"]
                        if version_id not in archive_cache:
                            archive_cache[version_id] = await self.fetcher(version_id, token)
                    await asyncio.to_thread(apply_project_skills, path, project, archive_cache)
                results.append({**result, "status": "applied", "error_code": None})
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                code = "name_conflict" if str(exc).startswith("name_conflict:") else (
                    "project_missing" if str(exc) == "project_missing" else "apply_failed"
                )
                results.append({**result, "status": "failed", "error_code": code})
        return results
