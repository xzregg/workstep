// Tests the unmodified NSIS installer on a disposable GitHub Windows runner.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { createRequire } = require('node:module')
const { parseArgs } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')

function assertWindowsRunner(platform, env) {
  assert(platform === 'win32' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_TEMP,
    'Acceptance requires a disposable GitHub Windows runner')
}
function validateVersion(value) {
  assert(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value || ''), 'Invalid release version')
  return value.replace(/^v/, '')
}
function installArguments(destination) { return ['/S', '/currentuser', `/D=${destination}`] }
function fixtureLabels(baseline = false) {
  return baseline
    ? { userName: 'Windows acceptance', projectName: 'WindowsAcceptance', workflowName: 'AcceptanceWorkflow', title: 'AcceptanceTask' }
    : { userName: 'Windows中文验收🙂', projectName: 'Windows验收项目', workflowName: '验收流程', title: 'Windows验收任务' }
}
function verifyChecksum(data, text) {
  const entries = text.split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64})\s+\*?WorkStep-windows-x64\.exe$/)).filter(Boolean)
  assert.equal(entries.length, 1, 'Expected one Windows installer checksum')
  assert.equal(createHash('sha256').update(data).digest('hex'), entries[0][1], 'Installer checksum mismatch')
}
function validateRuntime(url, health, updates, version, occupiedPort) {
  const parsed = new URL(url)
  assert.equal(parsed.protocol, 'http:'); assert.equal(parsed.hostname, '127.0.0.1')
  assert(Number(parsed.port) > 0)
  if (occupiedPort) assert.notEqual(Number(parsed.port), occupiedPort, 'Connected to the port occupier')
  assert.equal(health.status, 'ok'); assert.equal(health.version, version)
  assert.equal(updates.currentVersion, version)
  assert.match(updates.releaseUrl, /^https:\/\/github\.com\/xzregg\/workstep\/releases\//)
}
function validatePersistence(fixture, projects, task, memory) {
  assert(projects.projects.some(item => item.id === fixture.projectId), 'Project lost')
  assert.equal(task.id, fixture.taskId); assert.equal(task.title, fixture.title)
  assert.equal(memory.content, fixture.memory, 'Project memory lost')
}
async function waitFor(probe, message, timeout = 60000, interval = 500) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await delay(interval)
  }
  throw new Error(message)
}
async function exists(file) { return fs.access(file).then(() => true, () => false) }
async function reservePort() {
  const server = net.createServer(socket => socket.end())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, port: server.address().port }
}
async function execute(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', ...options })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(file)} timed out`)) }, 120000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}`)) })
  })
}
function parseApiResponse(endpoint, status, text) {
  assert(status >= 200 && status < 300, `${endpoint}: HTTP ${status}: ${text}`)
  return JSON.parse(text)
}
async function pageApi(page, endpoint, method = 'GET', body) {
  const result = await page.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, text: await response.text() }
  }, { endpoint, method, body })
  return parseApiResponse(endpoint, result.status, result.text)
}
async function openSettings(page) {
  if (await page.locator('#workstep-navigation').getAttribute('inert') !== null) {
    await page.getByRole('button', { name: '打开导航', exact: true }).click()
  }
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: /系统设置/ }).click()
}
async function waitForBrowserClose(browser, command, timeout) {
  let onDisconnect, timer
  const disconnected = new Promise(resolve => { onDisconnect = resolve; browser.once('disconnected', onDisconnect) })
  try {
    // Electron can close the CDP transport before acknowledging Browser.close.
    // Keep a timer alive and await that real disconnect, not a dangling promise.
    await Promise.race([
      command().catch(error => { if (browser.isConnected()) throw error }),
      disconnected,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Desktop quit command timed out')), timeout) }),
    ])
  } finally { clearTimeout(timer); browser.off('disconnected', onDisconnect) }
}
async function closeDesktop(browser) {
  const connection = await browser.newBrowserCDPSession()
  await waitForBrowserClose(browser, () => connection.send('Browser.close'), 15000)
}
async function cleanupBrowser(browser) {
  if (browser?.isConnected()) {
    await waitForBrowserClose(browser, () => browser.close(), 5000).catch(() => {})
  }
}
function installCompletionGuard(runtime = process, onError = console.error) {
  let completed = false
  runtime.once('beforeExit', () => {
    if (!completed) { onError('Windows acceptance ended before completion'); runtime.exitCode = 1 }
  })
  return () => { completed = true }
}

async function runAcceptance(options) {
  assertWindowsRunner(process.platform, process.env)
  const version = validateVersion(options.version)
  if (options['previous-installer']) validateVersion(options['previous-version'])
  const reportDir = path.resolve(process.env.WORKSTEP_ACCEPTANCE_REPORT_DIR || path.join(process.env.RUNNER_TEMP, 'windows-acceptance-report'))
  const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'workstep-windows-'))
  await fs.mkdir(reportDir, { recursive: true })
  const report = { version, runner: process.env.RUNNER_OS, checks: [],
    gaps: ['Windows 10/11 SmartScreen and real user desktop', 'Tray and native notifications',
      'WSL2/Podman sandbox', 'Real authenticated LLM execution', 'Native directory chooser and external browser handoff',
      'Live desktop GitHub update request (deterministic release cache used for UI checks)'] }
  const record = (name, details = {}) => { report.checks.push({ name, ...details }); console.log(`PASS ${name}`) }
  const installer = path.resolve(options.installer)
  const data = await fs.readFile(installer)
  if (options.checksums) verifyChecksum(data, await fs.readFile(options.checksums, 'utf8'))
  report.installerSha256 = createHash('sha256').update(data).digest('hex')
  if (options['previous-installer']) {
    assert(options['previous-checksums'], 'Upgrade baseline requires checksums')
    verifyChecksum(await fs.readFile(options['previous-installer']), await fs.readFile(options['previous-checksums'], 'utf8'))
  }
  const { chromium } = createRequire(path.join(__dirname, '../apps/desktop/package.json'))('playwright-core')
  const installDir = path.join(root, '安装目录 WorkStep')
  const executable = path.join(installDir, 'WorkStep.exe')
  const uninstall = path.join(installDir, 'Uninstall WorkStep.exe')
  async function install(source) {
    await execute(path.resolve(source), installArguments(installDir), { windowsVerbatimArguments: true })
    await waitFor(() => exists(executable), 'Installed executable missing')
    assert(await exists(path.join(installDir, 'resources/backend/python/python.exe')), 'Bundled Python missing')
    assert(await exists(path.join(installDir, 'resources/backend/legal/sbom.cdx.json')), 'SBOM missing')
  }
  async function uninstallAndCheck(scenario) {
    assert(await exists(uninstall), 'Uninstaller missing')
    await execute(uninstall, ['/S', '/currentuser'])
    await waitFor(async () => !await exists(executable), 'Uninstall did not remove application')
    assert(await exists(path.join(scenario.project, '.workstep/workstep.db')), 'Uninstall deleted project database')
    assert.equal(await fs.readFile(path.join(scenario.project, '.workstep/MEMORY.md'), 'utf8'), scenario.fixture.memory)
    assert(await exists(path.join(scenario.config, 'config.json')), 'Uninstall deleted daemon configuration')
    record(`${scenario.name}: uninstall preserves project and daemon data`)
  }
  async function scenario(name, baseline = false) {
    const directory = path.join(root, name)
    // Old Windows builds cannot persist Unicode configuration. Seed an ASCII
    // project there; the NEW build must still pass fresh Unicode + upgrade writes.
    const value = { name, config: path.join(directory, '配置目录'), project: path.join(directory, baseline ? 'project with spaces' : '中文项目 with spaces'),
      profile: path.join(directory, 'profile'), fixture: null }
    await fs.mkdir(value.project, { recursive: true }); await fs.mkdir(value.config, { recursive: true })
    return value
  }
  async function session(scenario, label, expectedVersion, seed, conflict = false) {
    // Avoid shared runner IP rate limits; the real IPC service must still match
    // this cache against app.getVersion(). Never modify app.asar or its fuses.
    await fs.mkdir(scenario.profile, { recursive: true })
    await fs.writeFile(path.join(scenario.profile, 'desktop-update.json'), JSON.stringify({
      currentVersion: expectedVersion, latestVersion: expectedVersion, updateAvailable: false,
      releaseUrl: `https://github.com/xzregg/workstep/releases/tag/v${expectedVersion}`, checkedAt: Date.now(),
    }))
    const debug = await reservePort(); await new Promise(resolve => debug.server.close(resolve))
    const occupied = conflict ? await reservePort() : null
    const log = await fs.open(path.join(reportDir, `${label}.log`), 'w')
    const child = spawn(executable, [`--remote-debugging-port=${debug.port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${scenario.profile}`, `--backend-port=${occupied?.port || 0}`, '--lang=zh-CN'], {
      stdio: ['ignore', log.fd, log.fd], env: { ...process.env, WORKSTEP_ENV: 'production',
        WORKSTEP_CONFIG_DIR: scenario.config, WORKSTEP_ENGINE_PACKAGE_DIR: path.join(scenario.config, 'runtime/python-packages') },
    })
    let browser, page, backendUrl, launchError
    child.once('error', error => { launchError = error })
    const pageErrors = []
    try {
      await waitFor(async () => {
        if (launchError) throw launchError
        if (child.exitCode !== null) throw new Error(`Desktop exited ${child.exitCode}`)
        return fetch(`http://127.0.0.1:${debug.port}/json/version`, { signal: AbortSignal.timeout(1000) })
          .then(response => response.ok, () => false)
      }, 'Desktop debugging endpoint did not start')
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debug.port}`, { timeout: 15000 })
      page = await waitFor(async () => browser.contexts().flatMap(context => context.pages())
        .find(item => item.url().startsWith('http://127.0.0.1:')), 'Desktop did not load local frontend')
      page.on('pageerror', error => pageErrors.push(error.message))
      page.setDefaultTimeout(30000)
      await page.locator('#root .app-shell').waitFor({ state: 'visible' })
      backendUrl = new URL(page.url()).origin
      const health = await pageApi(page, '/api/health')
      const updates = await page.evaluate(() => window.workstepDesktop.updates.status())
      validateRuntime(page.url(), health, updates, expectedVersion, occupied?.port)
      const denied = await fetch(`${backendUrl}/api/project/list`, { signal: AbortSignal.timeout(3000) })
      assert([401, 403].includes(denied.status), 'Business API accessible without desktop authentication')
      record(`${label}: installed Electron, bundled daemon, version, authenticated preload and API boundary`)
      if (conflict) record(`${label}: occupied preferred port falls back to own backend`)
      await page.evaluate(() => localStorage.setItem('workstep.locale', JSON.stringify({ state: { locale: 'zh-CN' }, version: 0 })))
      if (seed) {
        const labels = fixtureLabels(label === 'upgrade-baseline')
        await pageApi(page, '/api/system-settings', 'PUT', { user_name: labels.userName })
        const project = await pageApi(page, '/api/project/init', 'POST', { name: labels.projectName, path: scenario.project })
        const query = `?project_id=${encodeURIComponent(project.id)}`
        const workflow = await pageApi(page, `/api/workflow/create${query}`, 'POST', { name: labels.workflowName, is_default: true })
        const title = labels.title
        const task = await pageApi(page, `/api/task/create${query}`, 'POST', { title, description: 'No paid engine execution', auto_start: false, workflow_id: workflow.id })
        const memory = '# Windows验收记忆\n\n重启、升级、卸载后保留。\n'
        await pageApi(page, `/api/fs/memory${query}`, 'PUT', { content: memory })
        scenario.fixture = { ...labels, projectId: project.id, workflowId: workflow.id, taskId: task.id, title, memory }
      }
      const fixture = scenario.fixture
      if (label === 'upgrade-target') {
        fixture.userName = fixtureLabels().userName
        await pageApi(page, '/api/system-settings', 'PUT', { user_name: fixture.userName })
      }
      assert.equal((await pageApi(page, '/api/system-settings')).user_name, fixture.userName, 'User name lost')
      const query = `?project_id=${encodeURIComponent(fixture.projectId)}`
      validatePersistence(fixture, await pageApi(page, '/api/project/list'),
        await pageApi(page, `/api/task/${fixture.taskId}${query}`), await pageApi(page, `/api/fs/memory${query}`))
      await page.goto(`${backendUrl}/tasks?project=${encodeURIComponent(fixture.projectName)}&workflow=${encodeURIComponent(fixture.workflowId)}`)
      await page.getByText(fixture.title, { exact: true }).first().waitFor({ state: 'visible' })
      await page.screenshot({ path: path.join(reportDir, `${label}-tasks.png`) })
      await openSettings(page)
      await page.locator('.desktop-update-settings').waitFor({ state: 'visible' })
      await page.locator('.desktop-update-version').filter({ hasText: expectedVersion }).waitFor({ state: 'visible' })
      await page.screenshot({ path: path.join(reportDir, `${label}-settings.png`) })
      assert.deepEqual(pageErrors, [], 'Renderer errors')
      record(`${label}: project/task/memory persistence and actual task/settings UI`)
      // The real protocol handler brings the existing single-instance window home.
      await execute(executable, [`--user-data-dir=${scenario.profile}`, 'workstep://open'], {
        env: { ...process.env, WORKSTEP_ENV: 'production', WORKSTEP_CONFIG_DIR: scenario.config },
      })
      await page.waitForURL(`${backendUrl}/`)
      record(`${label}: deep link routed to existing desktop window`)
      await closeDesktop(browser)
      await waitFor(async () => child.exitCode !== null, 'Desktop did not quit', 15000)
      await waitFor(async () => fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(1000) })
        .then(() => false, () => true), 'Daemon survived desktop quit', 15000)
      record(`${label}: desktop quit stops bundled daemon`)
    } catch (error) {
      if (page) await page.screenshot({ path: path.join(reportDir, `${label}-failure.png`) }).catch(() => {})
      // Reproduce configuration writes with the ORIGINAL bundled Python in an
      // isolated fixture. Never dump config files, desktop tokens or user data.
      const diagnostic = await fs.open(path.join(reportDir, `${label}-config-diagnostic.log`), 'w')
      try {
        await execute(path.join(installDir, 'resources/backend/python/python.exe'), ['-c',
          "import sys, locale; sys.path.insert(0, sys.argv[1]); from services.config import config_store; print('UTF8_MODE', sys.flags.utf8_mode, 'FILE_ENCODING', locale.getencoding(), flush=True); config_store.set_user_name('Windows\\u81ea\\u52a8\\u9a8c\\u6536'); print('CONFIG_WRITE_OK', flush=True)",
          path.join(installDir, 'resources/backend/app/daemon')], {
          stdio: ['ignore', diagnostic.fd, diagnostic.fd],
          env: { ...process.env, WORKSTEP_ENV: 'production', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8',
            WORKSTEP_CONFIG_DIR: path.join(root, `${label}-diagnostic-config`) },
        })
      } catch (diagnosticError) { console.error(`Diagnostic: ${diagnosticError.message}`) }
      finally { await diagnostic.close() }
      throw error
    } finally {
      if (child.exitCode === null && child.pid) {
        // Exact owned PID/tree only; never kill by image name or port.
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
      await cleanupBrowser(browser)
      if (occupied) await new Promise(resolve => occupied.server.close(resolve))
      await log.close()
    }
  }
  try {
    const fresh = await scenario('fresh')
    await install(installer); record('fresh: NSIS installation in Chinese path with spaces')
    await session(fresh, 'fresh-first-launch', version, true)
    await session(fresh, 'fresh-restart', version, false, true)
    await uninstallAndCheck(fresh)
    if (options['previous-installer']) {
      const upgrade = await scenario('upgrade', true)
      await install(options['previous-installer'])
      await session(upgrade, 'upgrade-baseline', validateVersion(options['previous-version']), true)
      await install(installer); record('upgrade: original NSIS installer over previous release')
      await session(upgrade, 'upgrade-target', version, false)
      await session(upgrade, 'upgrade-restart', version, false)
      await uninstallAndCheck(upgrade)
    } else report.gaps.push('Upgrade baseline not supplied; upgrade was not tested')
    report.success = true
  } catch (error) { report.success = false; report.error = error.stack; throw error }
  finally { await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n') }
}
if (require.main === module) {
  const { values } = parseArgs({ options: Object.fromEntries(
    ['installer', 'version', 'checksums', 'previous-installer', 'previous-version', 'previous-checksums'].map(name => [name, { type: 'string' }])) })
  const completed = installCompletionGuard()
  runAcceptance(values).then(completed, error => { completed(); console.error(error); process.exitCode = 1 })
}
module.exports = { assertWindowsRunner, validateVersion, installArguments, verifyChecksum, validateRuntime, validatePersistence, waitFor, parseApiResponse, fixtureLabels, openSettings, closeDesktop, cleanupBrowser, installCompletionGuard }
