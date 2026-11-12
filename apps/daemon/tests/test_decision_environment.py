import asyncio
import time
import pytest
from services import decision_environment as env
from services.decision_models import DecisionModelService

GiB = 1024 ** 3


def facts(**changes):
    return dict(os='Linux', arch='x86_64', python=(3, 14), bits=64, libc=('glibc', '2.36'),
                mac_version='14.0', installer=True, writable=True, cpus=4,
                memory_total=8*GiB, memory_available=4*GiB, disk_free=10*GiB, **changes)


@pytest.mark.parametrize('system,arch', [('Linux','x86_64'), ('Linux','aarch64'), ('Windows','AMD64'), ('Darwin','arm64')])
def test_cpu_platforms_include_docker_and_windows(system, arch):
    value = facts(); value.update(os=system, arch=arch)
    assert env.evaluate(value, installed=False, loaded=False)['supported']


@pytest.mark.parametrize('change', [dict(memory_total=2*GiB),dict(memory_available=GiB), dict(disk_free=GiB),
    dict(cpus=1),dict(arch='armv7l'),dict(os='Windows',arch='ARM64'),dict(os='Darwin',arch='x86_64'),
    dict(libc=('musl','1.2')),dict(python=(3,10)),dict(installer=False),dict(writable=False)])
def test_unsupported_configuration_returns_actionable_reasons(change):
    value = facts(); value.update(change)
    result = env.evaluate(value, installed=False, loaded=False)
    assert not result['supported'] and result['reasons']


def test_installed_resources_do_not_require_download_space_or_installer():
    value = facts(); value.update(disk_free=GiB, installer=False, memory_available=GiB)
    assert env.evaluate(value, installed=True, loaded=True)['supported']


def test_container_limits_override_host_capacity(tmp_path):
    (tmp_path/'memory.max').write_text(str(2*GiB))
    (tmp_path/'memory.current').write_text(str(GiB))
    (tmp_path/'cpu.max').write_text('100000 100000')
    assert env.container_limits(16*GiB, 10*GiB, 8, tmp_path) == (2*GiB, GiB, 1)


@pytest.mark.asyncio
async def test_unsupported_blocks_managed_operations_but_not_external_settings(tmp_path, monkeypatch):
    service = DecisionModelService(tmp_path)
    monkeypatch.setattr(service, '_environment', lambda *args: {'supported':False,'reasons':['配置不够：可用内存不足']})
    for action in [lambda:service.download('model'), lambda:service.test({'mode':'managed'}),
                   lambda:service.configure({'mode':'managed','proxy_enabled':True})]:
        with pytest.raises(ValueError, match='配置不够'):
            await action()
    assert not tmp_path.joinpath('models').exists()
    await service.configure({'mode':'remote','base_url':'https://example.com','model':'jev'})
    assert (await service.snapshot())['settings']['mode'] == 'remote'
    await service.close()


@pytest.mark.asyncio
async def test_environment_probe_does_not_block_event_loop(tmp_path, monkeypatch):
    service = DecisionModelService(tmp_path)
    def slow(*args): time.sleep(.15); return {'supported':False,'reasons':['配置不够']}
    monkeypatch.setattr(service, '_environment', slow)
    task = asyncio.create_task(service.snapshot())
    await asyncio.sleep(.02)
    assert not task.done()
    await asyncio.wait_for(asyncio.sleep(.01), .05)
    await task
    await service.close()
