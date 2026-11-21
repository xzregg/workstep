"""Detect and install the official browser connector; all disk work runs off-loop."""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import threading
from itertools import islice
from pathlib import Path

from services.config import CONFIG_DIR, config_store
from services.connectors.store import connector_store

MCP_VERSION = '0.0.85'
KEY = 'digital_person_browser'
_install_task = None
_install_error = ''
_settings_lock = threading.RLock()


def directory():
    return CONFIG_DIR / 'runtime' / 'browser-control'


def package_candidates():
    yield directory() / 'node_modules/@playwright/mcp/cli.js'
    command = shutil.which('playwright-mcp')
    if command:
        yield Path(command).resolve()
    # Reuse local installations without invoking npx (which may download).
    npm = shutil.which('npm')
    if npm:
        try:
            result = subprocess.run([npm, 'root', '-g'], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                yield Path(result.stdout.strip()) / '@playwright/mcp/cli.js'
        except (OSError, subprocess.TimeoutExpired):
            pass
    cache = Path.home() / '.npm/_npx'
    if cache.is_dir():
        for item in islice(cache.iterdir(),100):
            yield item / 'node_modules/@playwright/mcp/cli.js'
    for item in connector_store.list():
        for argument in item.get('args', []):
            path = Path(argument)
            if path.is_absolute() and path.name in {'cli.js', 'cli.mjs'} and '@playwright' in str(path):
                yield path


def browser_candidates():
    if sys.platform == 'darwin':
        yield Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        yield Path.home() / 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        yield Path('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    elif sys.platform == 'win32':
        for root in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'):
            for name in ('Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'):
                if os.environ.get(root):
                    yield Path(os.environ[root]) / name
    else:
        for name in ('chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge'):
            command = shutil.which(name)
            if command:
                yield Path(command)
    bundled = Path('/opt/workstep-browser/browsers')
    if bundled.is_dir():
        yield from bundled.glob('chromium-*/chrome-linux*/chrome')


def probe_package(node, cli):
    script = """const {createRequire}=require('module');const req=createRequire(process.argv[1]);
const core=req('playwright-core');const path=require('path');
console.log(JSON.stringify({version:req('./package.json').version,browser:core.chromium.executablePath(),
core_cli:path.join(path.dirname(req.resolve('playwright-core/package.json')),'cli.js')}));"""
    env = {**os.environ, 'PLAYWRIGHT_BROWSERS_PATH': str(directory() / 'browsers')}
    # The immutable container browser cache must not be replaced by the HOME mount.
    if os.environ.get('PLAYWRIGHT_BROWSERS_PATH'):
        env['PLAYWRIGHT_BROWSERS_PATH'] = os.environ['PLAYWRIGHT_BROWSERS_PATH']
    try:
        result = subprocess.run([node, '-e', script, str(cli)], capture_output=True, text=True, timeout=5, env=env)
        return json.loads(result.stdout) if result.returncode == 0 else {}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {}


def detect():
    node, npm = shutil.which('node'), shutil.which('npm')
    cli, package = None, {}
    if node:
        for candidate in package_candidates():
            if candidate.is_file() and (info := probe_package(node, candidate)):
                cli, package = candidate, info
                break
    bundled = Path(package['browser']) if package.get('browser') else None
    browser = bundled if bundled and bundled.is_file() else next((p for p in browser_candidates() if p.is_file()), None)
    return {'node': node, 'npm': npm, 'cli': cli, 'package': package, 'browser': browser,
            'builtin': Path('/opt/workstep-browser/node_modules/playwright').is_dir()}


def engine_compatible():
    from services.connectors.runtime import engine_supports_mcp
    defaults = config_store.get_assistant_defaults('digital_person')
    engine = defaults.get('engine') or config_store.get_execution_default_engine()
    return engine_supports_mcp(engine)


def scan():
    found = detect()
    ready = bool(found['node'] and found['cli'] and found['browser'])
    state = config_store.get(KEY, {})
    connector = connector_store.resolve(state.get('connector_id', '')) if state.get('connector_id') else None
    return {'ready': ready, 'driver': bool(found['cli']), 'browser': bool(found['browser']),
            'node': bool(found['node']), 'npm': bool(found['npm']), 'builtin': found['builtin'],
            'version': found['package'].get('version', ''), 'engine_compatible': engine_compatible(),
            'status': 'ready' if ready else 'missing',
            'enabled': bool(state.get('enabled') and connector and connector.get('enabled')),
            'installing': bool(_install_task and not _install_task.done()), 'error': _install_error}


async def run_command(command, env):
    process = await asyncio.create_subprocess_exec(*map(str, command), env=env,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    try:
        code = await asyncio.wait_for(process.wait(), 600)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if code:
        raise ValueError('Browser component download failed. Please check your network and try again.')


async def install():
    found = await asyncio.to_thread(detect)
    if found['cli'] and found['browser']:
        return
    if not found['node'] or not found['npm']:
        raise ValueError('Please install Node.js 20 or a newer version, then rescan')
    await asyncio.to_thread(directory().mkdir, parents=True, exist_ok=True)
    env = {**os.environ, 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1',
           'PLAYWRIGHT_BROWSERS_PATH': os.environ.get('PLAYWRIGHT_BROWSERS_PATH') or str(directory() / 'browsers')}
    if not found['cli']:
        await run_command([found['npm'], 'install', '--prefix', directory(), '--no-audit', '--no-fund',
                           '--save-exact', f'@playwright/mcp@{MCP_VERSION}'], env)
        found = await asyncio.to_thread(detect)
    if not found['cli']:
        raise ValueError('Browser component failed installation verification. Please reinstall.')
    if not found['browser']:
        await run_command([found['node'], found['package']['core_cli'], 'install', 'chromium'], env)
    if not (await asyncio.to_thread(scan))['ready']:
        raise ValueError('No available browser detected. Please reinstall.')


async def start_install():
    global _install_task, _install_error
    if _install_task and not _install_task.done():
        return
    _install_error = ''
    async def job():
        global _install_error
        try:
            await install()
        except asyncio.CancelledError:
            raise
        except (OSError, ValueError, TimeoutError):
            _install_error = '浏览器组件下载失败，请检查 Node.js 与网络后重试'
    _install_task = asyncio.create_task(job(), name='digital-person-browser-install')


def set_enabled(enabled):
    with _settings_lock:
        return _set_enabled(enabled)


def _set_enabled(enabled):
    state = config_store.get(KEY, {})
    previous = connector_store.resolve(state.get('connector_id', '')) if state.get('connector_id') else None
    if enabled:
        if not engine_compatible():
            raise ValueError('The current digital human engine does not support MCP connectors. Please switch to a different engine.')
        found = detect()
        if not found['cli'] or not found['browser']:
            raise ValueError('Please install the browser operation component first')
        args = [str(found['cli']), '--headless', '--isolated', '--executable-path', str(found['browser'])]
        if found['builtin'] and sys.platform == 'linux' and os.geteuid() == 0:
            args.append('--no-sandbox')
        connector = connector_store.save({**({'id':previous['id'],'revision':previous['revision']} if previous else {}),
            'name':'Playwright 浏览器操作', 'description':'数字人的浏览器操作', 'kind':'mcp', 'transport':'stdio',
            'command':found['node'], 'args':args, 'enabled':True, 'project_ids':[]})
        config_store.set(KEY, {'enabled':True,'connector_id':connector['id']})
    else:
        if previous:
            connector_store.save({'id':previous['id'],'revision':previous['revision'],'name':previous['name'],'enabled':False})
        config_store.set(KEY, {**state,'enabled':False})
    return scan()


def attach(project_id, session_id):
    """Use the existing connector bridge; keep all other session selections."""
    state = config_store.get(KEY, {})
    if not state.get('enabled'):
        return
    item = connector_store.resolve(state.get('connector_id', ''))
    if not item or not connector_store.allowed(item, project_id):
        return
    selected = connector_store.selected(project_id, session_id)
    identifiers = [row['id'] for row in selected]
    if item['id'] not in identifiers:
        connector_store.select(project_id, session_id, identifiers + [item['id']])
