import pytest
from fastapi import HTTPException

from api.hook_errors import invoke_hook
from services.hook_errors import HookError


@pytest.mark.asyncio
@pytest.mark.parametrize('status', [404, 409, 422])
async def test_hook_domain_errors_keep_status_and_detail_at_api_boundary(status):
    async def operation():
        raise HookError(status, '钩子配置无效')

    with pytest.raises(HTTPException) as failure:
        await invoke_hook(operation())
    assert failure.value.status_code == status
    assert failure.value.detail == '钩子配置无效'
    assert isinstance(failure.value.__cause__, HookError)


@pytest.mark.asyncio
async def test_hook_adapter_preserves_success_and_unexpected_errors():
    async def success():
        return {'hooks': []}

    async def failure():
        raise RuntimeError('unexpected')

    assert await invoke_hook(success()) == {'hooks': []}
    with pytest.raises(RuntimeError, match='unexpected'):
        await invoke_hook(failure())
