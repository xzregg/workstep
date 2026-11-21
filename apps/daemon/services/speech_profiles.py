"""Saved cloud and remote speech connections, keyed by credential destination."""
from cryptography.fernet import Fernet

SECRET_FIELDS = ('api_key', 'secret_id', 'secret_key')
IDENTITY_FIELDS = ('mode', 'provider', 'base_url', 'region', 'app_id')


def identity(value):
    return tuple(value.get(key, '').strip().rstrip('/') if key == 'base_url'
                 else value.get(key, '').strip() for key in IDENTITY_FIELDS)


def remember(profiles, active):
    if active['mode'] not in ('cloud', 'remote'):
        return profiles
    return [active, *(row for row in profiles if identity(row) != identity(active))]


def find(profiles, target):
    key = identity(target)
    return next((row for row in profiles if identity(row) == key), {})


def public(value):
    return {k: v for k, v in value.items() if k not in SECRET_FIELDS} | {
        'has_' + k: bool(value.get(k)) for k in SECRET_FIELDS}


def transform_secrets(rows, transform):
    return [{**row, **{key: transform(row[key]) if row.get(key) else '' for key in SECRET_FIELDS}}
            for row in rows]


def decrypt(rows, key_path):
    if not any(row.get(key) for row in rows for key in SECRET_FIELDS):
        return rows
    cipher = Fernet(key_path.read_bytes())
    return transform_secrets(rows, lambda value: cipher.decrypt(value.encode()).decode())


def encrypt(rows, cipher):
    return transform_secrets(rows, lambda value: cipher.encrypt(value.encode()).decode())
