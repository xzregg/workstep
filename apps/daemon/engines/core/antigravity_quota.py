"""Read agy's native /usage text report without starting a model turn."""
import asyncio
import re
from datetime import datetime

from engines.core.process_cleanup import close_subprocess, finish_cleanup
from engines.core.quota import QuotaAuthenticationRequired, QuotaUnavailable

_WINDOWS = {'Weekly Limit Remaining': ('weekly', 10080), 'Five Hour Limit Remaining': ('five-hour', 300)}
MAX_REPORT_BYTES = 256 * 1024


def parse_quota(report: str) -> dict | None:
    groups = {}
    windows = []
    for line in report.splitlines():
        if not line.strip():
            continue
        columns = line.split('\t')
        if len(columns) != 4:
            return None
        name, label, percent, reset = (part.strip() for part in columns)
        if not name or label not in _WINDOWS:
            return None
        if percent == 'disabled' and not reset:
            continue
        if not re.fullmatch(r'\d+(?:\.\d+)?%', percent):
            return None
        remaining = float(percent[:-1])
        if not 0 <= remaining <= 100:
            return None
        try:
            date = datetime.fromisoformat(reset.replace('Z', '+00:00'))
            if date.tzinfo is None:
                return None
        except ValueError:
            return None
        kind, minutes = _WINDOWS[label]
        window = {'kind': kind, 'remaining_percent': remaining, 'used_percent': 100 - remaining,
                  'window_duration_mins': minutes, 'resets_at': int(date.timestamp())}
        groups.setdefault(name, {'name': name, 'windows': []})['windows'].append(window)
        windows.append(window)
    if not windows:
        return None
    return {'engine_id': 'antigravity', 'limit_name': 'Antigravity',
            'primary': windows[0],
            'groups': list(groups.values())}


async def read_quota(binary: str, cwd: str, timeout: float) -> dict:
    process = None
    launching = asyncio.create_task(asyncio.create_subprocess_exec(
        binary, '-p', '/usage', '--print-timeout', f'{timeout}s', cwd=cwd or None,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    ))
    try:
        async with asyncio.timeout(timeout):
            process = await asyncio.shield(launching)
            chunks, size = [], 0
            while chunk := await process.stdout.read(65536):
                size += len(chunk)
                if size > MAX_REPORT_BYTES:
                    raise QuotaUnavailable('invalid_report')
                chunks.append(chunk)
            await process.wait()
            report = b''.join(chunks).decode('utf-8', errors='replace')
            if report.strip().casefold() == 'authentication required':
                raise QuotaAuthenticationRequired()
            if process.returncode != 0:
                raise QuotaUnavailable('command_failed')
            quota = await asyncio.to_thread(parse_quota, report)
            if quota is None:
                raise QuotaUnavailable('invalid_report')
            return quota
    except TimeoutError as error:
        raise QuotaUnavailable('timeout') from error
    except OSError as error:
        raise QuotaUnavailable('command_failed') from error
    finally:
        async def cleanup():
            nonlocal process
            if process is None:
                try:
                    process = await launching
                except OSError:
                    return
            await close_subprocess(process)
        await finish_cleanup(cleanup())
