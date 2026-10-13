"""Short-lived provider snapshots for interactive directory previews only."""
from copy import deepcopy
import asyncio
from collections import defaultdict
import hashlib
import os
import time

from gateway.services.organization_settings import source_options


class DirectoryPreviewCache:
    def __init__(self, database, connectors, ttl=300):
        self.database, self.connectors, self.ttl = database, connectors, ttl
        self.entries = {}
        self.tree_entries = {}
        self.tree_locks = defaultdict(asyncio.Lock)

    async def _fingerprint(self, source):
        options = await source_options(self.database, source.id)
        return hashlib.sha256(repr((source.provider, source.tenant_id, source.client_id,
            source.agent_id, source.secret_env, os.environ.get(source.secret_env),
            options.get('encrypted_secret'))).encode()).digest()

    async def departments(self, source):
        async with self.tree_locks[source.id]:
            fingerprint = await self._fingerprint(source)
            now = time.monotonic()
            self.tree_entries = {id: entry for id, entry in self.tree_entries.items() if entry[1] > now}
            entry = self.tree_entries.get(source.id)
            if not entry or entry[0] != fingerprint:
                snapshot = await self.connectors[source.provider].fetch_directory(source, departments_only=True)
                entry = (fingerprint, time.monotonic() + self.ttl, deepcopy(snapshot))
                self.tree_entries[source.id] = entry
            return deepcopy(entry[2])

    async def fetch(self, source, selected, progress, *, refresh=False,full_directory=False):
        fingerprint = await self._fingerprint(source)
        connector=self.connectors[source.provider]
        tree=None
        if full_directory and getattr(connector,'supports_preloaded_departments',False):
            if refresh:self.tree_entries.pop(source.id,None)
            tree=await self.departments(source)
            selected=[row['external_id'] for row in tree['departments']]
        now = time.monotonic()
        # Drop expired entries as well as entries from replaced source credentials.
        self.entries = {id: entry for id, entry in self.entries.items() if entry[1] > now}
        entry = self.entries.get(source.id)
        if refresh or not entry or entry[0] != fingerprint:
            entry = None
        cached = deepcopy(entry[2]) if entry else None
        known = set(cached['selected_department_ids']) if cached else set()
        if full_directory and cached and set(selected)!=known:
            entry=None;cached=None;known=set()
        missing = [id for id in selected if id not in known]
        fetched = None
        if missing:
            options = {}
            if getattr(connector, 'supports_preloaded_departments', False):
                if tree is None:
                    if refresh:self.tree_entries.pop(source.id,None)
                    tree=await self.departments(source)
                options['preloaded_departments'] = tree['departments']
            fetched = await connector.fetch_directory(
                source, selected_department_ids=missing, progress=progress, **options)
        snapshot = self._merge(cached, fetched)
        expires = entry[1] if entry else time.monotonic() + self.ttl
        self.entries[source.id] = (fingerprint, expires, deepcopy(snapshot))
        # Cache may cover more departments than this particular preview requests.
        scope = set(selected)
        if fetched:
            scope.update(fetched.get('selected_department_ids') or [row['external_id'] for row in fetched['departments']])
        snapshot['selected_department_ids'] = list(dict.fromkeys([*selected, *(id for id in snapshot['selected_department_ids'] if id in scope)]))
        snapshot['departments'] = [row for row in snapshot['departments'] if row['external_id'] in scope]
        snapshot['people'] = [{**row, 'department_ids': [id for id in row['department_ids'] if id in scope]}
                              for row in snapshot['people'] if scope.intersection(row['department_ids'])]
        return snapshot, max(0, expires - time.monotonic())

    @staticmethod
    def _merge(cached, fetched):
        if fetched is None:
            return cached
        fetched = deepcopy(fetched)
        fetched['selected_department_ids'] = fetched.get('selected_department_ids') or [row['external_id'] for row in fetched['departments']]
        if cached is None:
            return fetched
        refreshed_scope = set(fetched['selected_department_ids'])
        departments = {row['external_id']: row for row in cached['departments'] if row['external_id'] not in refreshed_scope}
        departments.update({row['external_id']: row for row in fetched['departments']})
        people = {row['subject']: {**row, 'department_ids': [id for id in row['department_ids'] if id not in refreshed_scope]}
                  for row in cached['people'] if set(row['department_ids']) - refreshed_scope}
        for row in fetched['people']:
            previous = people.get(row['subject'], {})
            people[row['subject']] = {**row, 'department_ids': list(dict.fromkeys([
                *previous.get('department_ids', []), *row['department_ids']]))}
        return {**fetched, 'departments': list(departments.values()), 'people': list(people.values()),
                'selected_department_ids': list(dict.fromkeys([*cached['selected_department_ids'], *fetched['selected_department_ids']])),
                'complete': bool(cached.get('complete') and fetched.get('complete')),
                'whole_company': bool(cached.get('whole_company',True) and fetched.get('whole_company',True))}
