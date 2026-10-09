"""Renewable credentials bound to an existing delegated control key."""

import base64
import hashlib
import json
import time

from cryptography.hazmat.primitives import serialization

TTL = 30 * 24 * 60 * 60


def _decode(value):
    return base64.urlsafe_b64decode(value + '===')


def _claims(gateway_id, authorization, control_public_key_pem):
    key = serialization.load_pem_public_key(control_public_key_pem.encode())
    return {
        'kind': 'control.reconnect', 'gateway_id': gateway_id,
        'authorization_hash': hashlib.sha256(authorization.encode()).hexdigest(),
        'control_key_hash': hashlib.sha256(key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest(),
    }


def issue_reconnect_token(signer, gateway_id, authorization, control_public_key_pem):
    claims = _claims(gateway_id, authorization, control_public_key_pem)
    now = int(time.time())
    claims.update(iat=now, exp=now + TTL)
    payload = base64.urlsafe_b64encode(json.dumps(claims, sort_keys=True).encode()).rstrip(b'=').decode()
    signature = base64.urlsafe_b64encode(signer.private_key.sign(payload.encode())).rstrip(b'=').decode()
    return payload + '.' + signature


def verify_reconnect_token(signer, gateway_id, authorization, control_public_key_pem, token):
    if not isinstance(token, str) or len(token) > 2048:
        raise ValueError('Missing control reconnect credential')
    payload, signature = token.split('.')
    signer.private_key.public_key().verify(_decode(signature), payload.encode())
    claims = json.loads(_decode(payload))
    expected = _claims(gateway_id, authorization, control_public_key_pem)
    now = int(time.time())
    if (not isinstance(claims, dict) or any(claims.get(key) != value for key, value in expected.items())
            or type(claims.get('iat')) is not int or type(claims.get('exp')) is not int
            or claims['iat'] > now + 60 or claims['exp'] <= now
            or not 0 < claims['exp'] - claims['iat'] <= TTL):
        raise ValueError('Invalid control reconnect credential')
