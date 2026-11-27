"""End-to-end real Chromium <-> signal/STUN <-> daemon WebRTC P2P verification."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import re
import socket
import sys
from contextlib import suppress
from pathlib import Path

import httpx
import pytest
import uvicorn

DAEMON_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = DAEMON_DIR.parent.parent
SIGNAL_APP_DIR = REPO_ROOT / "apps" / "webrtc-signal"
SIGNAL_PKG_DIR = REPO_ROOT / "packages" / "webrtc-signal" / "src"
PROTO_PKG_DIR = REPO_ROOT / "packages" / "gateway-protocol" / "src"
WEB_DIST_DIR = REPO_ROOT / "apps" / "web" / "dist"
WEB_SHARE_DIST_DIR = REPO_ROOT / "apps" / "web" / "dist-gateway-share"
GATEWAY_WEB_DIST_DIR = REPO_ROOT / "apps" / "gateway-web" / "dist"
GATEWAY_PYTHON = REPO_ROOT / "apps" / "gateway" / ".venv" / "bin" / "python"


def _find_playwright_core() -> Path | None:
    override = os.environ.get("PLAYWRIGHT_CORE_PATH", "").strip()
    if override:
        p = Path(override)
        if (p / "package.json").is_file():
            return p

    roots = [REPO_ROOT]
    git_marker = REPO_ROOT / ".git"
    if git_marker.is_file():
        git_txt = git_marker.read_text(encoding="utf-8", errors="ignore")
        for line in git_txt.splitlines():
            if line.startswith("gitdir:"):
                gitdir = Path(line.split(":", 1)[1].strip())
                if not gitdir.is_absolute():
                    gitdir = (REPO_ROOT / gitdir).resolve()
                for parent in gitdir.parents:
                    if parent.name == ".git":
                        roots.append(parent.parent)
                        break

    for root in roots:
        candidate = root / "apps" / "desktop" / "node_modules" / "playwright-core"
        if (candidate / "package.json").is_file():
            return candidate
    return None


def _find_chromium_executable() -> Path | None:
    override = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE", "").strip()
    if override:
        p = Path(override)
        return p if p.is_file() else None

    cache_roots = [
        Path.home() / "Library" / "Caches" / "ms-playwright",
        Path.home() / ".cache" / "ms-playwright",
    ]
    patterns = (
        "chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell",
        "chromium-*/chrome-*/chrome",
        "chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    )
    for root in cache_roots:
        if not root.is_dir():
            continue
        for pat in patterns:
            for match in sorted(root.glob(pat), reverse=True):
                if match.is_file():
                    return match
    return None


def _reserve_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _no_proxy_env(base: dict[str, str] | None = None) -> dict[str, str]:
    cleaned = dict(base if base is not None else os.environ)
    for key in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        cleaned.pop(key, None)
    cleaned["NO_PROXY"] = "127.0.0.1,localhost"
    return cleaned


async def _wait_http_ready(url: str, timeout: float = 15.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    async with httpx.AsyncClient(timeout=1.0, trust_env=False) as client:
        while asyncio.get_running_loop().time() < deadline:
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    return
            except Exception:
                pass
            await asyncio.sleep(0.1)
    raise TimeoutError(f"Timed out waiting for {url}")


def _build_node_runner() -> str:
    return r"""
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);

const cfg = JSON.parse(process.env.E2E_CONFIG_JSON);
const screenshotDir = process.env.WORKSTEP_WEBRTC_SCREENSHOT_DIR || '';

const VIEWPORTS = [
  { name: '320', width: 320, height: 640 },
  { name: '390', width: 390, height: 844 },
  { name: '1023', width: 1023, height: 768 },
  { name: '1024', width: 1024, height: 768 },
  { name: '1440', width: 1440, height: 900 },
];

async function captureAcrossViewports(page, prefix) {
  const checks = [];
  if (!screenshotDir) return checks;
  fs.mkdirSync(screenshotDir, { recursive: true });
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(120);
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    if (prefix === 'local-settings-webrtc') {
      const aligned = await page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
        const save = rect('[data-testid="webrtc-save-btn"]');
        const check = rect('[data-testid="webrtc-check-btn"]');
        const title = rect('.webrtc-p2p-header h1');
        const refresh = rect('.webrtc-p2p-header button');
        return Math.abs(save.top - check.top) < 1 && Math.abs(save.height - check.height) < 1
          && Math.abs(title.top + title.height / 2 - refresh.top - refresh.height / 2) < 1;
      });
      if (!aligned) throw new Error('WebRTC settings actions are not aligned at ' + vp.name);
      await page.locator('[data-testid="webrtc-pair-qr"]').scrollIntoViewIfNeeded();
    }
    checks.push({ name: `${prefix}-${vp.name}`, ...metrics });
    await page.screenshot({ path: path.join(screenshotDir, `${prefix}-${vp.name}.png`), fullPage: false });
  }
  return checks;
}

function waitForGoLine() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.once('line', () => {
      rl.close();
      resolve();
    });
  });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: cfg.chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const consoleErrors = [];
  const layoutChecks = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.on('pageerror', (err) => {
      consoleErrors.push(`pageerror: ${err.message}`);
      console.error('BROWSER PAGEERROR:', err.message);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.error(`BROWSER CONSOLE [${msg.type()}]:`, msg.text());
      }
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        console.error(`BROWSER HTTP ${res.status()}: ${res.url()}`);
      }
    });

    await page.goto(cfg.p2pUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('#webrtc-remote-pair-key', { timeout: 15000 });
    layoutChecks.push(...(await captureAcrossViewports(page, 'p2p-pair')));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.fill('#webrtc-remote-pair-key', cfg.pairKey);
    await page.click('.webrtc-pair-form button[type="submit"]');

    try {
      await page.waitForSelector('[data-webrtc-connected="true"]', { timeout: 25000 });
    } catch (err) {
      const uiErr = await page.locator('.webrtc-pair-error').textContent().catch(() => '');
      const statusTxt = await page.locator('.webrtc-pair-status').textContent().catch(() => '');
      console.error('UI ERROR TEXT:', JSON.stringify(uiErr), 'STATUS:', JSON.stringify(statusTxt));
      throw err;
    }
    const candidatePath = (await page.textContent('[data-testid="webrtc-candidate-path"]')) || '';
    await page.waitForSelector('[data-testid="webrtc-latency"]', { timeout: 10000 });
    const latencyText = ((await page.textContent('[data-testid="webrtc-latency"]')) || '').trim();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(
      (name) => document.body && document.body.innerText.includes(name),
      cfg.projectName,
      { timeout: 15000 }
    );
    const sidebarStatus = ((await page.textContent('.gateway-connection-status [role="status"]')) || '').trim();

    process.stdout.write(JSON.stringify({ phase: 'connected', candidatePath, latencyText, sidebarStatus }) + '\n');
    await waitForGoLine();

    const transferResult = await page.evaluate(async ({ projectId, wsUrl }) => {
      const projRes = await fetch('/api/project/list');
      if (!projRes.ok) throw new Error('project list status ' + projRes.status);
      const projJson = await projRes.json();

      const wsPong = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws ping timeout')), 10000);
        const ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'ping', nonce: 'e2e-ws-ping' }));
        };
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(String(ev.data));
            if (parsed.type === 'pong' && parsed.nonce === 'e2e-ws-ping') {
              clearTimeout(timer);
              ws.close();
              resolve(parsed);
            }
          } catch {}
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error('ws error'));
        };
      });

      const dlRes = await fetch(`/api/fs/project-raw/${encodeURIComponent(projectId)}/payload.bin`);
      if (!dlRes.ok || !dlRes.body) throw new Error('download status ' + dlRes.status);
      const reader = dlRes.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      const digest = await crypto.subtle.digest('SHA-256', merged.buffer);
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      return {
        projectNames: Array.isArray(projJson.projects) ? projJson.projects.map((p) => p.name) : [],
        wsPong,
        downloadBytes: total,
        downloadSha256: hex,
      };
    }, { projectId: cfg.projectId, wsUrl: cfg.wsUrl });

    layoutChecks.push(...(await captureAcrossViewports(page, 'p2p-workbench')));

    if (screenshotDir) {
      // Also capture remote read-only WebRTC settings view over /p2p/<device_id>/
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(150);
      const settingsBtn = page.locator('button.layout-sidebar-settings-button:not(.layout-sidebar-appearance)').first();
      if (await settingsBtn.count()) {
        await settingsBtn.click();
        const remoteNav = page.locator('.settings-nav-button', { hasText: /远程访问|Remote access/i }).first();
        if (await remoteNav.count()) {
          await remoteNav.click();
          await page.waitForSelector('.webrtc-p2p-readonly', { timeout: 5000 });
          layoutChecks.push(...(await captureAcrossViewports(page, 'p2p-settings-readonly')));
        }
      }

      // Capture local workbench Settings -> Remote Access -> WebRTC Direct
      await page.close();
      const localPage = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
      await localPage.goto(cfg.daemonUrl, { waitUntil: 'networkidle' });
      const overlay = localPage.locator('.modal-overlay').first();
      if (await overlay.count()) {
        const overlayText = await overlay.textContent().catch(() => '');
        console.error('LOCAL PAGE INITIAL MODAL:', JSON.stringify(overlayText));
        const input = overlay.locator('input').first();
        if (await input.count()) {
          await input.fill('Operator');
          const skipBtn = overlay.locator('button').last();
          if (await skipBtn.count()) await skipBtn.click();
          await localPage.waitForTimeout(200);
        }
      }
      const localSettingsBtn = localPage.locator('button.layout-sidebar-settings-button:not(.layout-sidebar-appearance)').first();
      await localSettingsBtn.waitFor({ timeout: 15000 });
      await localSettingsBtn.click();
      const localRemoteNav = localPage.locator('.settings-nav-button', { hasText: /远程访问|Remote access/i }).first();
      await localRemoteNav.waitFor({ timeout: 10000 });
      await localRemoteNav.click();
      const webrtcTab = localPage.locator('.remote-access-tabs button').nth(1);
      await webrtcTab.waitFor({ timeout: 10000 });
      await webrtcTab.click();
      await localPage.waitForSelector('#webrtc-signal-url', { timeout: 10000 });
      await localPage.click('[data-testid="webrtc-save-btn"]');
      await localPage.waitForFunction(() => {
        const check = document.querySelector('[data-testid="webrtc-connectivity"]');
        return check && check.textContent.includes('UDP/STUN 可用');
      }, undefined, { timeout: 15000 });
      await localPage.waitForSelector('[data-testid="webrtc-pair-qr"] svg');
      await localPage.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async (value) => { window.__pairingLink = value; },
        } });
      });
      await localPage.click('[data-testid="webrtc-copy-pair-link"]');
      const linkMatches = await localPage.evaluate(({ url, key }) => {
        const link = new URL(window.__pairingLink);
        return link.origin + link.pathname === url && !link.search && new URLSearchParams(link.hash.slice(1)).get('pair_key') === key;
      }, { url: cfg.p2pUrl, key: cfg.pairKey });
      if (!linkMatches) throw new Error('QR pairing link does not match this device');
      if (screenshotDir) {
        await localPage.locator('[data-testid="webrtc-pair-qr"]').screenshot({ path: path.join(screenshotDir, 'pairing-qr.png') });
      }
      layoutChecks.push(...(await captureAcrossViewports(localPage, 'local-settings-webrtc')));
      await localPage.close();
    }

    process.stdout.write(JSON.stringify({
      phase: 'done',
      candidatePath,
      latencyText,
      sidebarStatus,
      consoleErrors,
      layoutChecks,
      ...transferResult,
    }) + '\n');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
"""


@pytest.mark.timeout(120)
@pytest.mark.asyncio
async def test_chromium_direct_webrtc_p2p_e2e(tmp_path, monkeypatch, caplog):
    import logging
    caplog.set_level(logging.DEBUG, logger="services.webrtc_p2p")
    caplog.set_level(logging.DEBUG, logger="aioice")
    caplog.set_level(logging.DEBUG, logger="workstep_webrtc_signal")
    playwright_core = _find_playwright_core()
    chromium_exe = _find_chromium_executable()
    if playwright_core is None or chromium_exe is None:
        pytest.skip("Playwright Chromium runtime unavailable")
    if not WEB_DIST_DIR.is_dir():
        pytest.skip("Built apps/web/dist not present; run yarn build first")

    for p in (SIGNAL_PKG_DIR, PROTO_PKG_DIR, DAEMON_DIR):
        p_str = str(p)
        if p_str not in sys.path:
            sys.path.insert(0, p_str)

    os.environ.setdefault("WORKSTEP_CONFIG_DIR", str(tmp_path / "daemon-cfg"))
    os.environ.setdefault("WORKSTEP_ENGINE_PACKAGE_DIR", str(tmp_path / "daemon-pkgs"))

    spec = importlib.util.spec_from_file_location("workstep_signal_app_main", SIGNAL_APP_DIR / "main.py")
    assert spec is not None and spec.loader is not None
    signal_main = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = signal_main
    spec.loader.exec_module(signal_main)

    import main as daemon_main
    from services.config import config_store

    config_store.set_user_name("Operator")
    monkeypatch.setattr(
        config_store,
        "_cache",
        {
            **config_store._load(),
            "user_name": "Operator",
            "default_project_directory": str(tmp_path),
        },
    )

    signal_port = _reserve_tcp_port()
    daemon_port = _reserve_tcp_port()

    signal_app = signal_main.create_app(
        signal_main.SignalSettings(
            host="127.0.0.1",
            port=signal_port,
            stun_host="127.0.0.1",
            stun_port=0,
            public_host="127.0.0.1",
            web_dist=WEB_DIST_DIR,
        )
    )

    daemon_main.event_bus._closed = False
    sig_server = uvicorn.Server(
        uvicorn.Config(signal_app, host="127.0.0.1", port=signal_port, log_level="warning")
    )
    daemon_server = uvicorn.Server(
        uvicorn.Config(daemon_main.app, host="127.0.0.1", port=daemon_port, log_level="warning")
    )

    sig_task = asyncio.create_task(sig_server.serve())
    daemon_task = asyncio.create_task(daemon_server.serve())

    try:
        await _wait_http_ready(f"http://127.0.0.1:{signal_port}/api/health")
        await _wait_http_ready(f"http://127.0.0.1:{daemon_port}/api/health")

        proj_dir = tmp_path / "e2e-project"
        proj_dir.mkdir(parents=True, exist_ok=True)
        payload_bytes = bytes(range(256)) * ((2500 * 1024) // 256)
        expected_sha256 = hashlib.sha256(payload_bytes).hexdigest()
        (proj_dir / "payload.bin").write_bytes(payload_bytes)

        async with httpx.AsyncClient(timeout=10.0, trust_env=False) as client:
            sys_resp = await client.put(
                f"http://127.0.0.1:{daemon_port}/api/system-settings",
                json={"user_name": "Operator"},
            )
            assert sys_resp.status_code == 200, sys_resp.text

            init_resp = await client.post(
                f"http://127.0.0.1:{daemon_port}/api/project/init",
                json={"path": str(proj_dir), "name": "e2e-project"},
            )
            assert init_resp.status_code == 200, init_resp.text
            project_id = init_resp.json()["id"]

            cfg_resp = await client.put(
                f"http://127.0.0.1:{daemon_port}/api/webrtc-p2p/settings",
                json={"enabled": True, "signal_url": f"http://127.0.0.1:{signal_port}"},
            )
            assert cfg_resp.status_code == 200, cfg_resp.text
            cfg_data = cfg_resp.json()
            device_id = cfg_data["device_id"]
            pair_key = cfg_data["pair_key"]
            assert device_id and pair_key

            online = False
            for _ in range(50):
                st = (await client.get(f"http://127.0.0.1:{daemon_port}/api/webrtc-p2p/settings")).json()
                if st.get("online"):
                    online = True
                    break
                await asyncio.sleep(0.1)
            assert online, "Daemon failed to connect to WebRTC signaling server"

        runner_path = tmp_path / "e2e_runner.cjs"
        runner_path.write_text(_build_node_runner(), encoding="utf-8")

        env = _no_proxy_env()
        env["PLAYWRIGHT_CORE_PATH"] = str(playwright_core)
        env["E2E_CONFIG_JSON"] = json.dumps({
            "chromiumPath": str(chromium_exe),
            "p2pUrl": f"http://127.0.0.1:{signal_port}/p2p/{device_id}/",
            "wsUrl": f"ws://127.0.0.1:{signal_port}/ws",
            "daemonUrl": f"http://127.0.0.1:{daemon_port}/",
            "pairKey": pair_key,
            "projectId": project_id,
            "projectName": "e2e-project",
        })

        proc = await asyncio.create_subprocess_exec(
            "node",
            str(runner_path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None

        try:
            connected_line = await asyncio.wait_for(proc.stdout.readline(), timeout=35.0)
        except asyncio.TimeoutError:
            proc.kill()
            stderr_out = (await proc.stderr.read()).decode("utf-8", errors="replace")
            pytest.fail(f"Playwright runner timed out waiting for connected phase:\n{stderr_out}")
        if not connected_line:
            stderr_out = (await proc.stderr.read()).decode("utf-8", errors="replace")
            pytest.fail(f"Playwright runner exited early:\n{stderr_out}")

        connected_msg = json.loads(connected_line.decode("utf-8"))
        assert connected_msg["phase"] == "connected"
        cand_path = connected_msg["candidatePath"]
        assert "relay" not in cand_path.lower()
        assert any(t in cand_path.lower() for t in ("host", "srflx", "prflx")), cand_path
        assert re.fullmatch(r"· \d+ ms", connected_msg["latencyText"]), connected_msg["latencyText"]
        assert re.search(r"· \d+ ms$", connected_msg["sidebarStatus"]), connected_msg["sidebarStatus"]

        # Check daemon-side nominated candidate pair & snapshot signaling hub relay counter
        async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
            status_resp = await client.get(f"http://127.0.0.1:{daemon_port}/api/webrtc-p2p/status")
            assert status_resp.status_code == 200
            status_data = status_resp.json()
            assert status_data["active_peers"] == 1
            cinfo = status_data["peers"][0]["candidate_info"]
            assert cinfo["local_type"] in {"host", "srflx", "prflx"}
            assert cinfo["remote_type"] in {"host", "srflx", "prflx"}

        relayed_before = signal_app.state.hub.relayed_messages

        proc.stdin.write(b"GO\n")
        await proc.stdin.drain()
        proc.stdin.close()

        done_line = await asyncio.wait_for(proc.stdout.readline(), timeout=60.0)
        rc = await asyncio.wait_for(proc.wait(), timeout=10.0)
        stderr_out = (await proc.stderr.read()).decode("utf-8", errors="replace")
        assert rc == 0, f"Playwright exited with {rc}:\n{stderr_out}"
        assert done_line, f"Missing done payload:\n{stderr_out}"

        done_msg = json.loads(done_line.decode("utf-8"))
        assert done_msg["phase"] == "done"
        assert "e2e-project" in done_msg["projectNames"]
        assert done_msg["wsPong"] == {"type": "pong", "nonce": "e2e-ws-ping"}
        assert done_msg["downloadBytes"] == len(payload_bytes)
        assert done_msg["downloadSha256"] == expected_sha256

        # Prove business traffic (/api/*, /ws, 2.5MB download) did NOT pass through signaling server
        assert signal_app.state.hub.relayed_messages == relayed_before

        for item in done_msg.get("layoutChecks", []):
            assert item["scrollWidth"] <= item["innerWidth"] + 1, f"Horizontal overflow on {item}"
    finally:
        daemon_server.should_exit = True
        sig_server.should_exit = True
        try:
            await asyncio.wait_for(
                asyncio.gather(daemon_task, sig_task, return_exceptions=True),
                timeout=5.0,
            )
        except asyncio.TimeoutError:
            for t in (daemon_task, sig_task):
                if not t.done():
                    t.cancel()
            with suppress(Exception):
                await asyncio.gather(daemon_task, sig_task, return_exceptions=True)


def _build_gateway_node_runner() -> str:
    return r"""
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);

const cfg = JSON.parse(process.env.E2E_CONFIG_JSON);
const screenshotDir = process.env.WORKSTEP_WEBRTC_SCREENSHOT_DIR || '';
const VIEWPORTS = [
  { name: '320', width: 320, height: 640 },
  { name: '390', width: 390, height: 844 },
  { name: '1023', width: 1023, height: 768 },
  { name: '1024', width: 1024, height: 768 },
  { name: '1440', width: 1440, height: 900 },
];

(async () => {
  const browser = await chromium.launch({
    executablePath: cfg.chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const consoleErrors = [];
  const layoutChecks = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    // Sign in as super_admin and prove the gateway account still cannot bypass the device key.
    await page.goto(`${cfg.gatewayUrl}/auth`, { waitUntil: 'networkidle' });
    const loginStatus = await page.evaluate(async ({ username, password }) => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      return res.status;
    }, { username: cfg.username, password: cfg.password });
    if (loginStatus !== 200) throw new Error(`Gateway browser login failed: ${loginStatus}`);

    const pairRequests = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/webrtc/pair') pairRequests.push(request.postData() || '');
    });
    await page.goto(cfg.p2pUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('#webrtc-remote-pair-key', { timeout: 15000 });
    if (pairRequests.length !== 0) throw new Error('Gateway account attempted passwordless pairing');
    await page.goto('about:blank');
    await page.goto(`${cfg.p2pUrl}#pair_key=${encodeURIComponent(cfg.pairKey)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-webrtc-connected="true"]', { timeout: 25000 });
    if (new URL(page.url()).hash) throw new Error('Pairing key remained in browser history');
    if (!pairRequests.length || pairRequests.some((body) => body.includes(cfg.pairKey) || JSON.parse(body).pair_key)) {
      throw new Error('Device secret was exposed to signaling');
    }
    const candidatePath = (await page.textContent('[data-testid="webrtc-candidate-path"]')) || '';
    await page.waitForSelector('[data-testid="webrtc-latency"]', { timeout: 10000 });
    const latencyText = ((await page.textContent('[data-testid="webrtc-latency"]')) || '').trim();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(
      (name) => document.body && document.body.innerText.includes(name),
      cfg.projectName,
      { timeout: 15000 }
    );
    const sidebarStatus = ((await page.textContent('.gateway-connection-status [role="status"]')) || '').trim();

    const transferResult = await page.evaluate(async ({ projectId, wsUrl }) => {
      const projRes = await fetch('/api/project/list');
      if (!projRes.ok) throw new Error('project list status ' + projRes.status);
      const projJson = await projRes.json();

      const wsPong = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws ping timeout')), 10000);
        const ws = new WebSocket(wsUrl);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'ping', nonce: 'gw-e2e-ping' }));
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(String(ev.data));
            if (parsed.type === 'pong' && parsed.nonce === 'gw-e2e-ping') {
              clearTimeout(timer);
              ws.close();
              resolve(parsed);
            }
          } catch {}
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error('ws error'));
        };
      });

      const dlRes = await fetch(`/api/fs/project-raw/${encodeURIComponent(projectId)}/payload.bin`);
      if (!dlRes.ok || !dlRes.body) throw new Error('download status ' + dlRes.status);
      const reader = dlRes.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      const digest = await crypto.subtle.digest('SHA-256', merged.buffer);
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      return {
        projectNames: Array.isArray(projJson.projects) ? projJson.projects.map((p) => p.name) : [],
        wsPong,
        downloadBytes: total,
        downloadSha256: hex,
      };
    }, { projectId: cfg.projectId, wsUrl: cfg.wsUrl });

    // Visit Gateway Admin -> Device Management and verify WebRTC devices section & responsive layout.
    await page.goto(`${cfg.gatewayUrl}/admin/devices`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.gateway-webrtc-devices-section table', { timeout: 15000 });
    await page.waitForFunction(
      ({ unboundName }) => document.body && document.body.innerText.includes(unboundName),
      { unboundName: cfg.unboundDeviceName },
      { timeout: 10000 }
    );

    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(120);
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      layoutChecks.push({ name: `admin-devices-${vp.name}`, ...metrics });
      if (screenshotDir) {
        await page.screenshot({ path: path.join(screenshotDir, `admin-devices-${vp.name}.png`), fullPage: false });
      }
    }

    if (screenshotDir) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('.gateway-webrtc-devices-section button', { hasText: '详情' }).first().click();
      await page.waitForSelector('dialog.gateway-modal[open]', { timeout: 5000 });
      await page.waitForTimeout(120);
      await page.screenshot({ path: path.join(screenshotDir, 'admin-devices-detail-1440.png'), fullPage: false });
      await page.locator('dialog.gateway-modal button[aria-label="关闭弹窗"]').click();
      await page.waitForTimeout(100);
    }

    process.stdout.write(JSON.stringify({
      phase: 'done',
      candidatePath,
      latencyText,
      sidebarStatus,
      consoleErrors,
      layoutChecks,
      ...transferResult,
    }) + '\n');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
"""


@pytest.mark.timeout(120)
@pytest.mark.asyncio
async def test_gateway_chromium_direct_webrtc_key_required_and_admin_e2e(tmp_path, monkeypatch):
    import base64
    from urllib.parse import parse_qs, urlsplit
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from websockets.asyncio.client import connect as ws_connect

    playwright_core = _find_playwright_core()
    chromium_exe = _find_chromium_executable()
    if playwright_core is None or chromium_exe is None:
        pytest.skip("Playwright Chromium runtime unavailable")
    if not GATEWAY_PYTHON.is_file():
        pytest.skip("Gateway virtualenv unavailable")
    if not WEB_SHARE_DIST_DIR.is_dir() or not GATEWAY_WEB_DIST_DIR.is_dir():
        pytest.skip("Built gateway-web/dist and web/dist-gateway-share required")

    for p in (SIGNAL_PKG_DIR, PROTO_PKG_DIR, DAEMON_DIR):
        p_str = str(p)
        if p_str not in sys.path:
            sys.path.insert(0, p_str)

    cfg_dir = tmp_path / "daemon-cfg"
    monkeypatch.setenv("WORKSTEP_CONFIG_DIR", str(cfg_dir))
    monkeypatch.setenv("WORKSTEP_ENGINE_PACKAGE_DIR", str(tmp_path / "daemon-pkgs"))

    import main as daemon_main
    from services import config as config_module
    from services.config import config_store

    monkeypatch.setattr(config_module, "CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(
        config_store,
        "_cache",
        {
            "user_name": "Operator",
            "default_project_directory": str(tmp_path),
            "device": {"device_id": "dev-gw-e2e-host", "device_name": "GatewayBoundMac"},
        },
    )

    gw_port = _reserve_tcp_port()
    daemon_port = _reserve_tcp_port()
    gw_url = f"http://127.0.0.1:{gw_port}"

    gw_env = {
        **_no_proxy_env(),
        "WORKSTEP_GATEWAY_DATA_DIR": str(tmp_path / "gw-data"),
        "WORKSTEP_GATEWAY_GATEWAY_ID": "e2e-gateway",
        "WORKSTEP_GATEWAY_PUBLIC_ORIGIN": gw_url,
        "WORKSTEP_GATEWAY_STUN_HOST": "127.0.0.1",
        "WORKSTEP_GATEWAY_STUN_PORT": "0",
        "WORKSTEP_GATEWAY_WEB_DIST": str(GATEWAY_WEB_DIST_DIR),
        "WORKSTEP_GATEWAY_WORKSPACE_WEB_DIST": str(WEB_SHARE_DIST_DIR),
    }
    gw_proc = await asyncio.create_subprocess_exec(
        str(GATEWAY_PYTHON),
        "-m",
        "uvicorn",
        "gateway.app:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(gw_port),
        cwd=str(REPO_ROOT / "apps" / "gateway"),
        env=gw_env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    daemon_main.event_bus._closed = False
    daemon_server = uvicorn.Server(
        uvicorn.Config(daemon_main.app, host="127.0.0.1", port=daemon_port, log_level="warning")
    )
    daemon_task = asyncio.create_task(daemon_server.serve())
    unbound_ws_ctx = None

    try:
        try:
            await _wait_http_ready(f"{gw_url}/api/health", timeout=20.0)
        except TimeoutError:
            if gw_proc.returncode is not None:
                err = (await gw_proc.stderr.read()).decode("utf-8", errors="replace")
                pytest.fail(f"Gateway exited early ({gw_proc.returncode}):\n{err}")
            raise
        await _wait_http_ready(f"http://127.0.0.1:{daemon_port}/api/health", timeout=15.0)

        owner_password = "OwnerPassphrase-2026!"
        async with httpx.AsyncClient(base_url=gw_url, timeout=10.0, trust_env=False) as gw_client:
            setup = await gw_client.post(
                "/api/platform/setup",
                json={
                    "username": "owner",
                    "display_name": "Owner",
                    "password": owner_password,
                    "recovery_username": "recovery",
                    "recovery_password": "RecoveryPassphrase-2026!",
                    "registration_mode": "closed",
                },
            )
            assert setup.status_code == 201, setup.text
            csrf = setup.json()["csrf_token"]
            assert (
                await gw_client.post(
                    "/api/auth/step-up",
                    headers={"X-CSRF-Token": csrf},
                    json={"password": owner_password},
                )
            ).status_code == 200

            key_info = (await gw_client.get("/api/platform/gateway-key")).json()
            gateway_id = key_info["gateway_id"]
            gw_fingerprint = key_info["fingerprint"]

            dev_priv = Ed25519PrivateKey.generate()
            dev_priv_pem = dev_priv.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode("ascii")
            dev_pub_pem = dev_priv.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            ).decode("ascii")
            app_instance_id = "inst-gw-e2e-01"
            verifier = "verif-" + "a" * 48
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            state = "state-" + "b" * 32
            nonce = "nonce-" + "c" * 32
            auth_res = await gw_client.post(
                "/api/desktop/authorize",
                headers={"X-CSRF-Token": csrf},
                json={
                    "gateway_id": gateway_id,
                    "app_instance_id": app_instance_id,
                    "state": state,
                    "nonce": nonce,
                    "code_challenge": challenge,
                },
            )
            assert auth_res.status_code == 200, auth_res.text
            code = parse_qs(urlsplit(auth_res.json()["callback_url"]).query)["code"][0]
            tok_res = await gw_client.post(
                "/api/desktop/token",
                json={
                    "code": code,
                    "state": state,
                    "nonce": nonce,
                    "code_verifier": verifier,
                    "app_instance_id": app_instance_id,
                    "gateway_id": gateway_id,
                    "device_public_key": dev_pub_pem,
                    "device_name": "GatewayBoundMac",
                    "version": "1.0.0",
                },
            )
            assert tok_res.status_code == 200, tok_res.text
            gw_device_id = tok_res.json()["device"]["id"]
            if tok_res.json()["device"]["status"] != "active":
                assert (
                    await gw_client.post(
                        f"/api/admin/devices/{gw_device_id}/approve",
                        headers={"X-CSRF-Token": csrf},
                    )
                ).status_code == 204

            ident_dir = cfg_dir / "gateway-identities"
            ident_dir.mkdir(parents=True, exist_ok=True)
            ident_name = "platform-" + hashlib.sha256(f"{gateway_id}:{gw_fingerprint}".encode()).hexdigest() + ".json"
            (ident_dir / ident_name).write_text(
                json.dumps({"app_instance_id": app_instance_id, "private_key": dev_priv_pem}),
                encoding="utf-8",
            )
            config_store.set(
                "gateway_platform",
                {
                    "url": gw_url,
                    "gateway_id": gateway_id,
                    "fingerprint": gw_fingerprint,
                    "enabled": True,
                    "authorized": True,
                },
            )

        proj_dir = tmp_path / "gw-e2e-project"
        proj_dir.mkdir(parents=True, exist_ok=True)
        payload_bytes = bytes(range(256)) * ((2500 * 1024) // 256)
        expected_sha256 = hashlib.sha256(payload_bytes).hexdigest()
        (proj_dir / "payload.bin").write_bytes(payload_bytes)

        async with httpx.AsyncClient(timeout=10.0, trust_env=False) as d_client:
            init_resp = await d_client.post(
                f"http://127.0.0.1:{daemon_port}/api/project/init",
                json={"path": str(proj_dir), "name": "gw-e2e-project"},
            )
            assert init_resp.status_code == 200, init_resp.text
            project_id = init_resp.json()["id"]

            cfg_resp = await d_client.put(
                f"http://127.0.0.1:{daemon_port}/api/webrtc-p2p/settings",
                json={"enabled": True, "signal_url": gw_url},
            )
            assert cfg_resp.status_code == 200, cfg_resp.text
            webrtc_device_id = cfg_resp.json()["device_id"]

            for _ in range(50):
                st = (await d_client.get(f"http://127.0.0.1:{daemon_port}/api/webrtc-p2p/settings")).json()
                if st.get("online"):
                    break
                await asyncio.sleep(0.1)
            else:
                pytest.fail("Daemon failed to register WebRTC with Gateway")

        # Register a second signaling-only WebRTC device so Admin UI screenshots cover both binding modes.
        sig_priv = Ed25519PrivateKey.generate()
        sig_pub_pem = sig_priv.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("ascii")
        unbound_ws = await ws_connect(f"ws://127.0.0.1:{gw_port}/ws/webrtc/device")
        unbound_ws_ctx = unbound_ws
        reg_nonce = json.loads(await unbound_ws.recv())["nonce"]
        verifier_hex = hashlib.sha256(b"salt:key").hexdigest()
        reg_sig = base64.urlsafe_b64encode(
            sig_priv.sign(f"workstep-webrtc-device-v1:{reg_nonce}:rtc-unbound-1:{verifier_hex}".encode("utf-8"))
        ).rstrip(b"=").decode("ascii")
        await unbound_ws.send(json.dumps({
            "type": "register",
            "device_id": "rtc-unbound-1",
            "device_name": "LabSignalNode",
            "public_key_pem": sig_pub_pem,
            "signature": reg_sig,
            "pair_key_salt": "salt",
            "pair_key_verifier": verifier_hex,
        }))
        assert json.loads(await unbound_ws.recv())["type"] == "registered"

        runner_path = tmp_path / "gw_e2e_runner.cjs"
        runner_path.write_text(_build_gateway_node_runner(), encoding="utf-8")

        env = _no_proxy_env()
        env["PLAYWRIGHT_CORE_PATH"] = str(playwright_core)
        env.setdefault(
            "WORKSTEP_WEBRTC_SCREENSHOT_DIR",
            str(REPO_ROOT / "tmp" / "webrtc-p2p" / "gateway-screenshots"),
        )
        env["E2E_CONFIG_JSON"] = json.dumps({
            "chromiumPath": str(chromium_exe),
            "gatewayUrl": gw_url,
            "username": "owner",
            "password": owner_password,
            "pairKey": cfg_resp.json()["pair_key"],
            "p2pUrl": f"{gw_url}/p2p/{webrtc_device_id}/",
            "wsUrl": f"ws://127.0.0.1:{gw_port}/ws",
            "projectId": project_id,
            "projectName": "gw-e2e-project",
            "unboundDeviceName": "LabSignalNode",
        })

        proc = await asyncio.create_subprocess_exec(
            "node",
            str(runner_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout_data, stderr_data = await asyncio.wait_for(proc.communicate(), timeout=90.0)
        assert proc.returncode == 0, f"Playwright failed ({proc.returncode}):\n{stderr_data.decode()}"
        result = json.loads(stdout_data.decode("utf-8").strip().splitlines()[-1])
        assert result["phase"] == "done"
        assert result["consoleErrors"] == []
        assert "relay" not in result["candidatePath"].lower()
        assert any(t in result["candidatePath"].lower() for t in ("host", "srflx", "prflx")), result["candidatePath"]
        assert re.fullmatch(r"· \d+ ms", result["latencyText"]), result["latencyText"]
        assert re.search(r"· \d+ ms$", result["sidebarStatus"]), result["sidebarStatus"]
        assert "gw-e2e-project" in result["projectNames"]
        assert result["wsPong"] == {"type": "pong", "nonce": "gw-e2e-ping"}
        assert result["downloadBytes"] == len(payload_bytes)
        assert result["downloadSha256"] == expected_sha256
        for item in result["layoutChecks"]:
            assert item["scrollWidth"] <= item["innerWidth"] + 1, f"Horizontal overflow on {item}"
    finally:
        if unbound_ws_ctx is not None:
            with suppress(Exception):
                await unbound_ws_ctx.close()
        with suppress(Exception):
            await daemon_main.app.state.webrtc_client.close()
        daemon_server.should_exit = True
        with suppress(Exception):
            await asyncio.wait_for(daemon_task, timeout=5.0)
        if gw_proc.returncode is None:
            gw_proc.terminate()
            try:
                await asyncio.wait_for(gw_proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                gw_proc.kill()
                await gw_proc.wait()

