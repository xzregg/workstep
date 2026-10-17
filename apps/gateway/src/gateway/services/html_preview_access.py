"""Bind an opaque preview's file ticket to the session which opened it.

Sandboxed requests cannot rely on SameSite browser cookies. This is a narrowly
scoped, bounded credential bridge for GETs of that one resource ticket only.
The normal identity/device/project checks still run on every resource request.
"""
from collections import OrderedDict
from dataclasses import replace
import re
import time

from gateway.services.identity import COOKIE_NAME

GRANT_HEADER = 'x-workstep-preview-grant'
_RESOURCE = re.compile(r'/api/fs/html-resource/([^/]+)/([A-Za-z0-9_-]{43})/.+\Z')


def _store(call):
    owner = call.control_connections
    if not hasattr(owner, 'html_preview_grants'):
        owner.html_preview_grants = OrderedDict()
    return owner.html_preview_grants


def _key(call, project_id, token):
    return (call.proofs.get('host', ''), call.workspace_path or '', project_id, token)


def register_preview_grant(call, token):
    credential = call.tokens.get(COOKIE_NAME)
    if not credential or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
        return
    store = _store(call)
    now = time.monotonic()
    for key in list(store):
        if store[key][0] <= now:
            del store[key]
    while len(store) >= 1024:
        store.popitem(last=False)
    store[_key(call, call.query_values.get('project_id') or '_', token)] = (now + 3600, credential)


def preview_resource_identity(call):
    match = _RESOURCE.fullmatch(call.target.path) if call.operation == 'GET' else None
    if match is None:
        return call
    grant = _store(call).get(_key(call, *match.groups()))
    if grant is None or grant[0] <= time.monotonic():
        return call
    # Never expose this credential to the browser or to the upstream host.
    return replace(call, tokens={**call.tokens, COOKIE_NAME: grant[1]})
