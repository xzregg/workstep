import time
import asyncio

from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from test_external_identity import _setup


def test_preview_cache_fetches_only_missing_departments_refreshes_and_expires(tmp_path):
    calls = []
    tree_calls = []
    tree_entered = asyncio.Event()

    class Connector:
        async def fetch_directory(self, source, *, selected_department_ids=None, progress=None, departments_only=False):
            if departments_only:
                tree_calls.append(source.client_id)
                tree_entered.set()
                await asyncio.sleep(.4)
                return {'departments': [{'external_id': '2', 'display_name': '研发'}], 'people': []}
            calls.append(list(selected_department_ids))
            return {'departments': [{'external_id': id, 'display_name': id} for id in selected_department_ids],
                    'people': [{'subject': 'shared', 'display_name': '员工', 'department_ids': selected_department_ids}],
                    'complete': True, 'selected_department_ids': selected_department_ids}

    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors = {'dingtalk': Connector()}
    with TestClient(app, base_url='https://gateway.test') as client:
        headers = {'X-CSRF-Token': _setup(client)}
        source = client.post('/api/admin/identity-sources', headers=headers, json={
            'provider': 'dingtalk', 'tenant_id': 'corp', 'client_id': 'app', 'client_secret': 'secret',
        }).json()['id']
        base = f'/api/admin/identity-sources/{source}'

        # Reopening the dialog reuses the full organization tree, too.
        assert client.get(base + '/directory-preview').status_code == 200
        assert client.get(base + '/directory-preview').status_code == 200
        assert tree_calls == ['app']

        async def overlapping_reopens():
            from httpx import ASGITransport, AsyncClient
            app.state.directory_reconciler.jobs.preview_cache.tree_entries.clear()
            tree_entered.clear()
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=client.cookies) as actor:
                pending = [asyncio.create_task(actor.get(base + '/directory-preview')) for _ in range(2)]
                await asyncio.wait_for(tree_entered.wait(), 2)
                assert (await asyncio.wait_for(actor.get('/api/health'), .2)).status_code == 200
                assert not all(task.done() for task in pending)
                responses = await asyncio.gather(*pending)
                assert all(response.status_code == 200 for response in responses)
        client.portal.call(overlapping_reopens)
        assert tree_calls == ['app', 'app']

        def preview(ids, **kwargs):
            response = client.post(base + '/sync-jobs', headers=headers, json={'department_ids': ids, 'preview': True, **kwargs})
            assert response.status_code == 202, response.text
            for _ in range(100):
                job = client.get(base + '/sync-jobs/latest').json()
                if job['status'] in ('preview', 'failed'): break
                time.sleep(.01)
            assert job['status'] == 'preview', job
            assert 'snapshot' not in job
            return job

        preview(['2'])
        expanded = preview(['2', '3'])
        assert calls == [['2'], ['3']]
        assert expanded['result']['user_candidates'][0]['department_ids'] == ['2', '3']
        preview(['2'])
        assert calls == [['2'], ['3']]
        # Updating the application credentials must discard the old source cache.
        updated = client.put(base, headers=headers, json={
            'provider': 'dingtalk', 'tenant_id': 'corp', 'client_id': 'changed-app', 'client_secret': 'new-secret',
        })
        assert updated.status_code == 200, updated.text
        assert client.get(base + '/directory-preview').status_code == 200
        assert tree_calls == ['app', 'app', 'changed-app']
        preview(['2'])
        assert calls[-1] == ['2']
        preview(['2', '3'], refresh=True)
        assert calls[-1] == ['2', '3']
        jobs = app.state.directory_reconciler.jobs
        jobs.preview_cache.ttl = 0
        preview(['2'], refresh=True)
        preview(['2'])
        assert calls[-2:] == [['2'], ['2']]


def test_merging_overlapping_provider_scopes_replaces_removed_memberships():
    from gateway.services.directory_preview_cache import DirectoryPreviewCache
    old = {'departments': [{'external_id': '2'}], 'people': [
        {'subject': 'gone', 'department_ids': ['2']},
        {'subject': 'shared', 'department_ids': ['2']},
    ], 'selected_department_ids': ['2'], 'complete': True}
    new = {'departments': [{'external_id': '1'}, {'external_id': '2'}], 'people': [
        {'subject': 'shared', 'department_ids': ['1']},
    ], 'selected_department_ids': ['1', '2'], 'complete': True}
    merged = DirectoryPreviewCache._merge(old, new)
    assert merged['people'] == [{'subject': 'shared', 'department_ids': ['1']}]
    assert old['people'][0]['department_ids'] == ['2']


def test_full_preview_drops_old_user_scope_when_refreshed_tree_visibility_changes(tmp_path):
    from gateway.database import GatewayDatabase
    from gateway.services.external_identity import ExternalIdentityService
    from gateway.services.directory_preview_cache import DirectoryPreviewCache
    async def scenario():
        db=GatewayDatabase(GatewaySettings(data_dir=tmp_path));await db.start()
        try:
            source=await ExternalIdentityService(db).create_source('wecom','corp','app','SECRET')
            state={'ids':['1','2'],'whole':True};reads=[]
            class Connector:
                supports_preloaded_departments=True
                async def fetch_directory(self,source,*,departments_only=False,selected_department_ids=None,**kwargs):
                    departments=[{'external_id':id,'display_name':id} for id in state['ids']]
                    if departments_only:return {'departments':departments,'people':[]}
                    reads.append(list(selected_department_ids))
                    return {'departments':departments,'people':[],'selected_department_ids':state['ids'],
                            'complete':True,'whole_company':state['whole']}
            cache=DirectoryPreviewCache(db,{'wecom':Connector()})
            await cache.fetch(source,['1','2'],None,full_directory=True)
            state.update(ids=['2'],whole=False);cache.tree_entries.clear()
            snapshot,_=await cache.fetch(source,['1','2'],None,full_directory=True)
            assert reads==[['1','2'],['2']]
            assert snapshot['whole_company'] is False
            assert snapshot['selected_department_ids']==['2']
        finally:await db.close()
    asyncio.run(scenario())
