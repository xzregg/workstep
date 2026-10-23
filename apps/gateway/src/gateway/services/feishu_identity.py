"""Feishu and Lark enterprise OAuth and scoped contact directory adapters."""
import base64
import hashlib
from copy import deepcopy
from urllib.parse import urlencode

import httpx

from gateway.services.external_identity import ExternalProfile
from gateway.services.identity_connectors import _secret


def _checked(response):
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or data.get('code', 0) != 0 or data.get('error'):
        raise ValueError('Feishu provider rejected request')
    return data


class FeishuConnector:
    supports_preloaded_departments = True
    supports_redirect_uri = True

    def __init__(self, client_factory=None, secret_resolver=None):
        self.client_factory = client_factory or (lambda: httpx.AsyncClient(timeout=15))
        self.secret_resolver = secret_resolver

    @staticmethod
    def _domain(source):
        return 'https://open.larksuite.com' if source.provider == 'lark' else 'https://open.feishu.cn'

    def authorization_url(self, source, state, nonce, redirect_uri):
        challenge = base64.urlsafe_b64encode(hashlib.sha256(nonce.encode()).digest()).decode().rstrip('=')
        domain = 'https://accounts.larksuite.com' if source.provider == 'lark' else 'https://accounts.feishu.cn'
        return domain + '/open-apis/authen/v1/authorize?' + urlencode({
            'client_id': source.client_id, 'response_type': 'code', 'redirect_uri': redirect_uri,
            'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256',
        })

    async def exchange_code(self, source, code, nonce, *, redirect_uri):
        async with self.client_factory() as client:
            token = _checked(await client.post(self._domain(source) + '/open-apis/authen/v2/oauth/token', json={
                'grant_type': 'authorization_code', 'client_id': source.client_id,
                'client_secret': await _secret(source, self.secret_resolver), 'code': code,
                'code_verifier': nonce, 'redirect_uri': redirect_uri,
            })).get('access_token')
            if not token:
                raise ValueError('Feishu user token missing')
            profile = _checked(await client.get(self._domain(source) + '/open-apis/authen/v1/user_info',
                headers={'Authorization': 'Bearer ' + token})).get('data') or {}
            if profile.get('tenant_key') != source.tenant_id or not profile.get('open_id'):
                raise ValueError('Feishu tenant or member identity mismatch')
            return ExternalProfile(tenant_id=profile['tenant_key'], subject=profile['open_id'],
                                   display_name=profile.get('name') or profile['open_id'])

    async def _pages(self, client, source, token, path, **params):
        seen = set()
        for _ in range(10000):
            data = _checked(await client.get(self._domain(source) + path,
                headers={'Authorization': 'Bearer ' + token}, params={
                    'page_size': 100, 'user_id_type': 'open_id', 'department_id_type': 'open_department_id', **params,
                })).get('data')
            if not isinstance(data, dict) or not isinstance(data.get('has_more'), bool):
                raise ValueError('Invalid Feishu directory page')
            yield data
            if not data['has_more']:
                return
            cursor = data.get('page_token')
            if not cursor or cursor in seen:
                raise ValueError('Feishu directory cursor did not advance')
            seen.add(cursor)
            params['page_token'] = cursor
        raise ValueError('Feishu directory pagination limit reached')

    async def fetch_directory(self, source, *, selected_department_ids=None, departments_only=False,
                              progress=None, preloaded_departments=None):
        async with self.client_factory() as client:
            token = _checked(await client.post(self._domain(source) + '/open-apis/auth/v3/tenant_access_token/internal',
                json={'app_id': source.client_id, 'app_secret': await _secret(source, self.secret_resolver)})).get('tenant_access_token')
            if not token:
                raise ValueError('Feishu tenant token missing')
            granted = set()
            scope_verified = False
            try:
                async for page in self._pages(client, source, token, '/open-apis/contact/v3/scopes'):
                    ids = page.get('department_ids')
                    if not isinstance(ids, list):
                        raise ValueError('Feishu scope metadata missing')
                    granted.update(str(value) for value in ids)
                scope_verified = True
            except (httpx.HTTPError, ValueError):
                # A partial view cannot authorize removal of absent members.
                granted.clear()
            departments = deepcopy(preloaded_departments) if preloaded_departments is not None else [{
                'external_id': '0', 'display_name': 'Lark 组织' if source.provider == 'lark' else '飞书组织',
                'parent_external_id': None,
            }]
            if preloaded_departments is None:
                async for page in self._pages(client, source, token, '/open-apis/contact/v3/departments/0/children', fetch_child='true'):
                    if not isinstance(page.get('items'), list):
                        raise ValueError('Invalid Feishu department list')
                    for item in page['items']:
                        identifier = item.get('open_department_id')
                        if not identifier or not item.get('name'):
                            raise ValueError('Invalid Feishu department')
                        departments.append({'external_id': identifier, 'display_name': item['name'],
                                            'parent_external_id': item.get('parent_department_id') or '0'})
            if len(departments) > 10000 or len({d['external_id'] for d in departments}) != len(departments):
                raise ValueError('Invalid Feishu directory size or duplicate department')
            if departments_only:
                return {'departments': departments, 'people': []}
            parents = {d['external_id']: d.get('parent_external_id') for d in departments}
            selected = set(selected_department_ids) if selected_department_ids is not None else set(parents)
            if not selected or selected - parents.keys():
                raise ValueError('Unknown selected Feishu department')
            def descends(identifier, ancestors):
                visited = set()
                while identifier and identifier not in visited:
                    if identifier in ancestors:
                        return True
                    visited.add(identifier)
                    identifier = parents.get(identifier)
                return False
            chosen = {identifier for identifier in parents if descends(identifier, selected)}
            complete = scope_verified and all(descends(identifier, granted) for identifier in chosen)
            people = {}
            if progress:
                await progress('fetching', 0, len(chosen), None)
            for count, identifier in enumerate(sorted(chosen), 1):
                async for page in self._pages(client, source, token, '/open-apis/contact/v3/users/find_by_department', department_id=identifier):
                    if not isinstance(page.get('items'), list):
                        raise ValueError('Invalid Feishu member list')
                    for member in page['items']:
                        subject = member.get('open_id')
                        if not subject or not isinstance(member.get('department_ids'), list):
                            raise ValueError('Feishu directory member lacks stable identity or departments')
                        memberships = set(member['department_ids']) & chosen
                        status = member.get('status') or {}
                        active = not any(status.get(key) for key in ('is_resigned', 'is_exited', 'is_frozen'))
                        previous = people.get(subject, {})
                        people[subject] = {'subject': subject, 'display_name': member.get('name') or subject,
                            'department_ids': sorted(memberships | set(previous.get('department_ids', []))),
                            'active': active and previous.get('active', True)}
                if progress:
                    await progress('fetching', count, len(chosen), identifier)
            return {'departments': [row for row in departments if row['external_id'] in chosen],
                    'people': list(people.values()), 'complete': complete, 'whole_company': scope_verified and '0' in granted,
                    'selected_department_ids': None if selected_department_ids is None else sorted(chosen)}
