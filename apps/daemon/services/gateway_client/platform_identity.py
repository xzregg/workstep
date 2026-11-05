"""Keep one installation identity across verified addresses of the same Gateway."""
import base64
import hashlib
import json
import os

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization

from services import config as config_module


def _decode(value):
    return base64.urlsafe_b64decode(value + '===')


def platform_identity(gateway_id, gateway_key, fallback):
    fingerprint = hashlib.sha256(gateway_key.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()
    directory = config_module.CONFIG_DIR / 'gateway-identities'
    path = directory / ('platform-' + hashlib.sha256(
        f'{gateway_id}:{fingerprint}'.encode()).hexdigest() + '.json')
    if path.exists():
        return json.loads(path.read_text())
    value = fallback
    # Older versions keyed identities by URL. Only migrate an identity backed
    # by a signed authorization and a previously established control session.
    for connection_path in sorted((config_module.CONFIG_DIR / 'gateway-connections').glob('*.json')):
        identity_path = directory / connection_path.name
        if not identity_path.is_file():
            continue
        try:
            credential = json.loads(connection_path.read_text())
            if not credential.get('reconnect_token'):
                continue
            header, payload, signature = credential['authorization'].split('.')
            if json.loads(_decode(header)) != {'alg': 'EdDSA', 'typ': 'JWT'}:
                continue
            gateway_key.verify(_decode(signature), f'{header}.{payload}'.encode())
            claims = json.loads(_decode(payload))
            if claims.get('gateway_id') != gateway_id or claims.get('iss') != gateway_id:
                continue
            candidate = json.loads(identity_path.read_text())
            if candidate['app_instance_id'] != claims.get('app_instance_id'):
                continue
            key = serialization.load_pem_private_key(candidate['private_key'].encode(), password=None)
            public = key.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
            if public != claims.get('device_public_key'):
                continue
            value = candidate
            break
        except (OSError, ValueError, KeyError, TypeError, AttributeError, InvalidSignature):
            continue
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return json.loads(path.read_text())
    with os.fdopen(fd, 'w') as file:
        json.dump(value, file)
    return value
