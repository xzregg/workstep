"""User-configured Gateway login via browser PKCE, without a special package."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import platform
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from workstep_gateway_protocol import ManagedGatewayPayload
from workstep_gateway_protocol.origin import validate_gateway_origin
from services.config import config_store
from services import config as config_module

COOKIE = 'workstep_platform_local_session'


def normalize_origin(value: str) -> str:
    return validate_gateway_origin(value.strip().removesuffix('/'))


def configured_payload():
    stored = config_store.get('gateway_platform', {})
    if not isinstance(stored, dict) or not stored.get('authorized'): return None
    return ManagedGatewayPayload(gateway_id=stored['gateway_id'], gateway_origin=stored['url'],
        gateway_public_key_fingerprint=stored['fingerprint'], deployment_channel='settings', min_protocol_version=1)


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def _identity(origin: str) -> dict:
    directory = config_module.CONFIG_DIR / 'gateway-identities'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / (hashlib.sha256(origin.encode()).hexdigest() + '.json')
    if path.exists(): return json.loads(path.read_text())
    key = Ed25519PrivateKey.generate()
    value = {'app_instance_id': secrets.token_urlsafe(24), 'private_key': key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file: json.dump(value, file)
    return value


class GatewayBrowserLogin:
    def __init__(self, gateway, client_factory=None):
        self.gateway = gateway
        self.client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=10, follow_redirects=False))
        self.pending = None
        self.desktop_local_session = None
        self.lock = asyncio.Lock()

    async def settings(self):
        stored = await asyncio.to_thread(config_store.get, 'gateway_platform', {})
        client = self.gateway.control_client
        return {'url': stored.get('url', ''), 'configured': bool(stored.get('url')),
            'authenticated': bool(self.gateway.current_user_id), 'online': bool(client and client.online),
            'pending_device': bool(stored.get('pending_device')), 'package_locked': bool(os.environ.get('WORKSTEP_MANAGED_BUNDLE_DIR'))}

    async def begin(self, origin: str, callback_origin: str, *, desktop: bool = False) -> str:
        origin = normalize_origin(origin)
        callback_origin = normalize_origin(callback_origin)
        if os.environ.get('WORKSTEP_MANAGED_BUNDLE_DIR'):
            raise ValueError('This installation has a package-pinned Gateway')
        async with self.lock:
            async with self.client_factory() as client:
                response = await client.get(origin + '/api/platform/gateway-key')
                response.raise_for_status()
                data = response.json()
            key = serialization.load_pem_public_key(data['public_key_pem'].encode())
            if not isinstance(key, Ed25519PublicKey): raise ValueError('Invalid Gateway key')
            fingerprint = hashlib.sha256(key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
            if not hmac.compare_digest(fingerprint, data['fingerprint']): raise ValueError('Gateway key mismatch')
            old = await asyncio.to_thread(config_store.get, 'gateway_platform', {})
            if old.get('url') == origin and old.get('fingerprint') and old['fingerprint'] != fingerprint:
                raise ValueError('Gateway key changed; verify the platform before reconnecting')
            identity = await asyncio.to_thread(_identity, origin)
            verifier = secrets.token_urlsafe(48)
            state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.pending = {'url': origin, 'gateway_id': data['gateway_id'], 'fingerprint': fingerprint,
                'desktop': desktop, 'identity': identity, 'verifier': verifier, 'state': state, 'nonce': nonce, 'expires': time.monotonic()+300}
            # Saving an address alone never enables controlled mode or grants access.
            stored = {**old, 'url': origin, 'gateway_id': data['gateway_id'], 'fingerprint': fingerprint}
            if old.get('url') != origin: stored['authorized'] = False
            await asyncio.to_thread(config_store.set, 'gateway_platform', stored)
            query = {'gateway_id': data['gateway_id'], 'app_instance_id': identity['app_instance_id'],
                'state': state, 'nonce': nonce, 'code_challenge': _encode(hashlib.sha256(verifier.encode()).digest()),
                'redirect_uri': callback_origin + '/api/gateway-platform/callback'}
            return origin + '/desktop/login?' + urlencode(query)

    async def complete(self, code: str, state: str):
        async with self.lock:
            pending = self.pending
            if not pending or pending['expires'] <= time.monotonic() or not hmac.compare_digest(state, pending['state']):
                raise ValueError('Gateway login expired or invalid state')
            self.pending = None
            identity = pending['identity']
            key = serialization.load_pem_private_key(identity['private_key'].encode(), password=None)
            public_key = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
            async with self.client_factory() as client:
                response = await client.post(pending['url']+'/api/desktop/token', json={
                    'code': code, 'state': state, 'nonce': pending['nonce'], 'code_verifier': pending['verifier'],
                    'app_instance_id': identity['app_instance_id'], 'gateway_id': pending['gateway_id'],
                    'device_public_key': public_key, 'device_name': platform.node() or 'WorkStep daemon',
                    'version': __import__('version').APP_VERSION})
                response.raise_for_status()
                result = response.json()
            stored = {'url': pending['url'], 'gateway_id': pending['gateway_id'], 'fingerprint': pending['fingerprint'],
                'authorized': bool(result.get('device_authorization')), 'pending_device': not bool(result.get('device_authorization'))}
            if not result.get('device_authorization'):
                await asyncio.to_thread(config_store.set, 'gateway_platform', stored)
                return None
            # Verify authorization before replacing the current connection.
            from .identity import ManagedAuthorizationVerifier
            authorization = result['device_authorization']
            proof = _encode(key.sign(authorization.encode()))
            verifier = ManagedAuthorizationVerifier(pending['gateway_id'], pending['url'], pending['fingerprint'], client_factory=self.client_factory)
            actor = await verifier.verify(authorization, proof)
            if actor.app_instance_id != identity['app_instance_id']: raise ValueError('Installation binding mismatch')
            control_key = Ed25519PrivateKey.generate()
            control_public = control_key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
            # Delegate challenge signing using the existing Desktop protocol.
            fingerprint = hashlib.sha256(control_key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
            delegation = _encode(key.sign(f'workstep-control-delegate-v1:{authorization}:{fingerprint}'.encode()))
            control_private = control_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
            await self.gateway.close()
            await asyncio.to_thread(config_store.set, 'gateway_platform', stored)
            await self.gateway.start()
            result = await self.gateway.bootstrap(authorization, proof, control_private, control_public, delegation)
            self.desktop_local_session = result[0] if pending["desktop"] else None
            return result
