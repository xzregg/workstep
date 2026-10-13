from datetime import datetime, timezone

from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.services.usage_ledger import record_usage_batch


def test_observed_models_bulk_prices_and_future_fallback(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="price-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        }).json()
        headers = {"X-CSRF-Token": setup["csrf_token"]}
        occurred_at = datetime.now(timezone.utc).isoformat()
        def event(id, model, **extra):
            return {"usage_event_id": id, "model": model, "input_tokens": 1000000,
                    "output_tokens": 1000000, "cache_read_tokens": 200000,
                    "cache_write_tokens": 100000, "total_tokens": 2000000,
                    "cache_input_included": True,
                    "occurred_at": occurred_at, **extra}
        def send(events):
            return client.portal.call(record_usage_batch, app.state.database, "device", "batch", events)
        assert len(send([event("old-a", "model-a"), event("old-b", "model-b"),
                         event("unknown", None)])['accepted']) == 3
        models = client.get('/api/admin/usage/model-prices').json()
        assert models['total'] == 2
        assert [row['model'] for row in models['models']] == ['model-a', 'model-b']
        assert models['models'][0]['prices'] is None
        assert client.get('/api/admin/usage/model-prices?q=model-b').json()['total'] == 1
        assert client.get('/api/admin/usage/model-prices?page_size=1&page=2').json()['models'][0]['model'] == 'model-b'
        prices = {'input_per_million':'2', 'output_per_million':'4',
                  'cache_read_per_million':'0.5', 'cache_write_per_million':'3'}
        body = {'models':['model-a', 'model-b'], 'prices':prices}
        assert client.put('/api/admin/usage/model-prices', json=body).status_code == 403
        assert client.put('/api/admin/usage/model-prices', headers=headers,
                          json={**body,'prices':{**prices,'input_per_million':'-1'}}).status_code == 422
        assert client.post('/api/auth/step-up', headers=headers,json={'password':'OwnerPassphrase-2026!'}).status_code == 200
        assert client.put('/api/admin/usage/model-prices', headers=headers,
                          json={**body,'models':['model-a','never-used']}).status_code == 422
        assert all(row['prices'] is None for row in client.get('/api/admin/usage/model-prices').json()['models'])
        for invalid in ('NaN', 'Infinity', '1000001', '0.000000001'):
            assert client.put('/api/admin/usage/model-prices',headers=headers,
                json={**body,'prices':{**prices,'input_per_million':invalid}}).status_code == 422
        assert client.put('/api/admin/usage/model-prices',headers=headers,
            json={**body,'models':['model-a','model-a']}).status_code == 422
        saved = client.put('/api/admin/usage/model-prices', headers=headers, json=body)
        assert saved.status_code == 200, saved.text
        assert saved.json()['updated'] == 2
        assert all(row['prices'] == prices for row in client.get('/api/admin/usage/model-prices').json()['models'])
        assert client.get('/api/admin/usage/events').json()['events'][0]['estimated_cost'] is None
        assert send([event('new-a','model-a'), event('new-b','model-b', cache_input_included=False),
                     event('known','model-a',estimated_cost='7',currency='CNY'),
                     event('unmetered','model-a',metering_status='unmetered',input_tokens=None,
                           output_tokens=None,cache_read_tokens=None,cache_write_tokens=None,total_tokens=None),
                     event('ambiguous','model-a',cache_input_included=None)])['rejected'] == []
        rows = {row['id']:row for row in client.get('/api/admin/usage/events').json()['events']}
        assert rows['new-a']['estimated_cost'] == '5.800000'
        assert rows['new-b']['estimated_cost'] == '6.400000'
        assert rows['new-a']['currency'] == 'USD'
        assert rows['new-a']['pricing_version'] == saved.json()['version']
        assert rows['known']['estimated_cost'] == '7.000000' and rows['known']['currency'] == 'CNY'
        assert rows['old-a']['estimated_cost'] is None
        assert rows['unmetered']['estimated_cost'] is None
        assert rows['ambiguous']['estimated_cost'] is None
        assert send([event('new-a','model-a')])['duplicates'] == ['new-a']
        summary = client.get('/api/admin/usage').json()
        assert summary['currency'] == 'mixed'
        # Missing cache counts are not guessed as zero.
        assert send([event('no-cache-info','model-a',cache_read_tokens=None,cache_write_tokens=None)])['accepted']
        assert client.get('/api/admin/usage/events').json()['events'][0]['estimated_cost'] is None

        zero = {field:'0' for field in prices}
        changed = client.put('/api/admin/usage/model-prices',headers=headers,json={'models':['model-a'],'prices':zero})
        assert changed.status_code == 200
        assert changed.json()['version'] != saved.json()['version']
        send([event('zero','model-a')])
        rows = {row['id']:row for row in client.get('/api/admin/usage/events').json()['events']}
        assert rows['zero']['estimated_cost'] == '0.000000'
        assert rows['new-a']['estimated_cost'] == '5.800000'
        assert rows['new-a']['pricing_version'] == saved.json()['version']

        # Slow model catalog SQL leaves lightweight health requests responsive.
        import asyncio
        import threading
        import time
        from httpx import ASGITransport, AsyncClient
        from sqlalchemy import event as sql_event
        reached = threading.Event()
        def slow_sql(connection,cursor,statement,parameters,context,many):
            if 'usage_events.model' in statement and 'GROUP BY' in statement:
                def delay():
                    reached.set(); time.sleep(.4); return 1
                # SQLite executes the UDF on the aiosqlite worker, not inside the event hook.
                connection.connection.dbapi_connection.create_function('price_delay',0,delay)
                statement = statement.replace('WHERE ', 'WHERE (SELECT price_delay()) = 1 AND ',1)
            return statement, parameters
        engine = app.state.database.engine.sync_engine
        sql_event.listen(engine,'before_cursor_execute',slow_sql,retval=True)
        async def canary():
            async with AsyncClient(transport=ASGITransport(app=app),base_url='https://gateway.test',cookies=client.cookies) as actor:
                pending = asyncio.create_task(actor.get('/api/admin/usage/model-prices'))
                try:
                    assert await asyncio.to_thread(reached.wait,2)
                    assert (await asyncio.wait_for(actor.get('/api/health'),.25)).status_code == 200
                    assert not pending.done()
                finally: response = await pending
                assert response.status_code == 200
        try: client.portal.call(canary)
        finally: sql_event.remove(engine,'before_cursor_execute',slow_sql)
        client.cookies.clear()
        assert client.get('/api/admin/usage/model-prices').status_code == 401
