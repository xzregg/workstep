import asyncio

import pytest

from engines.antigravity import AntigravityEngine
from engines.core.antigravity_quota import parse_quota
from engines.core.quota import query_quota

REPORT = ('Gemini Models\tWeekly Limit Remaining\t85%\t2026-12-02T03:20:26Z\n'
          'Claude and GPT models\tWeekly Limit Remaining\t73%\t2026-12-02T03:31:21Z\n'
          'Claude and GPT models\tFive Hour Limit Remaining\t73%\t2026-11-25T08:31:21Z\n')


def test_native_quota_report_preserves_groups_windows_and_reset_times():
    quota = parse_quota(REPORT)
    assert quota['primary']['remaining_percent'] == 85
    assert quota['primary'] == quota['groups'][0]['windows'][0]
    assert len(quota['groups']) == 2
    assert quota['groups'][0]['name'] == 'Gemini Models'
    assert [w['window_duration_mins'] for w in quota['groups'][1]['windows']] == [10080, 300]
    assert quota['groups'][1]['windows'][1]['resets_at'] == 1795595481
    assert parse_quota('Authentication required') is None
    assert parse_quota(REPORT.replace('85%', '185%')) is None


def test_native_report_keeps_valid_windows_when_another_is_disabled():
    disabled = 'Gemini Models\tFive Hour Limit Remaining\tdisabled\t\n'
    assert parse_quota(disabled + REPORT) == parse_quota(REPORT)
    assert parse_quota(disabled) is None


@pytest.mark.asyncio
async def test_quota_calls_native_report_without_a_model_turn(monkeypatch, tmp_path):
    import sys
    original = asyncio.create_subprocess_exec
    script = tmp_path / 'report.py'
    script.write_text(f'print({REPORT!r})')
    commands = []
    async def start(*command, **kwargs):
        commands.append(command)
        return await original(sys.executable, str(script), **kwargs)
    monkeypatch.setattr(AntigravityEngine, 'resolve_binary', staticmethod(lambda: '/managed/agy'))
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', start)
    result = await AntigravityEngine().get_quota(str(tmp_path))
    assert result['groups'][0]['windows'][0]['remaining_percent'] == 85
    assert commands[0][:3] == ('/managed/agy', '-p', '/usage')
    assert '--dangerously-skip-permissions' not in commands[0]


@pytest.mark.asyncio
async def test_quota_timeout_reaps_its_owned_process(monkeypatch, tmp_path):
    import sys
    original = asyncio.create_subprocess_exec
    processes = []
    async def start(*command, **kwargs):
        process = await original(sys.executable, '-c', 'import time; time.sleep(60)', **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr(AntigravityEngine, 'resolve_binary', staticmethod(lambda: '/managed/agy'))
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', start)
    monkeypatch.setattr(AntigravityEngine, 'QUOTA_TIMEOUT_SECONDS', .1, raising=False)
    result = await query_quota(AntigravityEngine(), str(tmp_path))
    assert result['status'] == 'unavailable'
    assert result['reason'] == 'timeout'
    assert processes[0].returncode is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(('report', 'exit_code', 'status', 'reason'), [
    ('Authentication required', 1, 'unauthenticated', None),
    ('unexpected report with private contents', 0, 'unavailable', 'invalid_report'),
    ('private CLI diagnostics', 1, 'unavailable', 'command_failed'),
])
async def test_quota_reports_safe_failure_reason(monkeypatch, tmp_path, report, exit_code, status, reason):
    import sys
    original = asyncio.create_subprocess_exec

    async def start(*command, **kwargs):
        return await original(sys.executable, '-c', f'print({report!r}); raise SystemExit({exit_code})', **kwargs)

    monkeypatch.setattr(AntigravityEngine, 'resolve_binary', staticmethod(lambda: '/managed/agy'))
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', start)
    result = await query_quota(AntigravityEngine(), str(tmp_path))
    assert result['status'] == status
    assert result.get('reason') == reason
    assert result['quota'] is None
    assert report not in str(result)


@pytest.mark.asyncio
async def test_quota_cancellation_during_launch_does_not_leak_process(monkeypatch, tmp_path):
    import sys
    original = asyncio.create_subprocess_exec
    created, finish = asyncio.Event(), asyncio.Event()
    processes = []
    async def start(*command, **kwargs):
        process = await original(sys.executable, '-c', 'import time; time.sleep(60)', **kwargs)
        processes.append(process)
        created.set()
        await finish.wait()
        return process
    monkeypatch.setattr(AntigravityEngine, 'resolve_binary', staticmethod(lambda: '/managed/agy'))
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', start)
    task = asyncio.create_task(AntigravityEngine().get_quota(str(tmp_path)))
    await created.wait()
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()
    finish.set()
    await asyncio.gather(task, return_exceptions=True)
    assert processes[0].returncode is not None
