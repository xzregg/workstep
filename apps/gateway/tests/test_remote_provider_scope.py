from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from gateway import remote_access_api as remote


@pytest.mark.asyncio
async def test_stream_checks_current_user_supplier_grants(monkeypatch):
    current = ['supplier', 'newly-granted']
    async def compile_access(database, device_id, user_id):
        assert (database, device_id, user_id) == ('db', 'pc', 'remote-user')
        return current, []
    monkeypatch.setattr(remote, 'compiled_provider_access', compile_access)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database='db')))
    await remote._check_provider_grants(request, 'pc', 'remote-user', ['supplier'])
    current.remove('supplier')
    with pytest.raises(HTTPException) as rejected:
        await remote._check_provider_grants(request, 'pc', 'remote-user', ['supplier'])
    assert rejected.value.status_code == 403
