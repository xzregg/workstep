// Runs only on disposable GitHub macOS runners, against the actual DMG.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { parseArgs } = require('node:util')
const { createRequire } = require('node:module')
const { waitFor, closeDesktop, cleanupBrowser, installCompletionGuard } = require('./windows-desktop-acceptance.cjs')

function validateOptions(options, platform = process.platform, env = process.env) {
  assert(platform === 'darwin' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_TEMP,
    'Acceptance requires a disposable GitHub macOS runner')
  assert(['x64', 'arm64'].includes(options.arch), 'Invalid macOS architecture')
  const version = String(options.version || '').replace(/^v/, '')
  assert(/^\d+\.\d+\.\d+$/.test(version), 'Invalid release version')
  assert(options.installer && path.extname(options.installer) === '.dmg', 'DMG installer required')
  return { ...options, version, machine: options.arch === 'x64' ? 'x86_64' : 'arm64' }
}

async function runAcceptance(input) {
  const options = validateOptions(input)
  const reportDir = path.join(process.env.RUNNER_TEMP, `macos-acceptance-${options.arch}`)
  await fs.mkdir(reportDir, { recursive: true })
  const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'workstep-macos-'))
  const mount = path.join(root, 'mount')
  const app = path.join(root, 'WorkStep.app')
  const config = path.join(root, '配置目录')
  const profile = path.join(root, 'profile')
  const report = { version: options.version, arch: options.arch, checks: [], success: false,
    gaps: ['Gatekeeper/quarantine on a real user machine', 'Upgrade/uninstall on existing installations',
      'Real model execution and Podman sandbox', 'Tray, native notifications and external browser handoff'] }
  const record = name => { report.checks.push({ name }); console.log(`PASS ${name}`) }
  let mounted = false, browser, child
  const { chromium } = createRequire(path.join(__dirname, '../apps/desktop/package.json'))('playwright-core')
  const api = async (page, endpoint, method = 'GET', body) => {
    const result = await page.evaluate(async ({ endpoint, method, body }) => {
      const response = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, data: await response.json() }
    }, { endpoint, method, body })
    assert.equal(result.status, 200, endpoint)
    return result.data
  }
  async function launch(label) {
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(path.join(profile, 'desktop-update.json'), JSON.stringify({
      currentVersion: options.version, latestVersion: options.version, updateAvailable: false,
      releaseUrl: `https://github.com/xzregg/workstep/releases/tag/v${options.version}`, checkedAt: Date.now(),
    }))
    const server = net.createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    const log = await fs.open(path.join(reportDir, `${label}.log`), 'w')
    child = spawn(path.join(app, 'Contents/MacOS/WorkStep'), [`--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--backend-port=0', '--lang=zh-CN'], {
      env: { ...process.env, WORKSTEP_ENV: 'production', WORKSTEP_CONFIG_DIR: config,
        WORKSTEP_ENGINE_PACKAGE_DIR: path.join(config, 'runtime/python-packages') }, stdio: ['ignore', log.fd, log.fd],
    })
    let launchError
    child.once('error', error => { launchError = error })
    try {
      await waitFor(async () => {
        if (launchError) throw launchError
        assert(child.exitCode === null, `Desktop exited ${child.exitCode}`)
        return fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)
      }, 'Desktop debug endpoint did not start')
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      const page = await waitFor(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:')),
        'Desktop did not load local frontend')
      await page.locator('#root .app-shell').waitFor({ state: 'visible' })
      const health = await api(page, '/api/health')
      assert.equal(health.version, options.version)
      const updates = await page.evaluate(() => window.workstepDesktop.updates.status())
      assert.equal(updates.currentVersion, options.version)
      const origin = new URL(page.url()).origin
      const denied = await fetch(origin + '/api/project/list')
      assert([401, 403].includes(denied.status), 'Desktop API must require authentication')
      record(`${label}: actual Electron window, daemon version and authentication`)
      if (label === 'first-launch') await api(page, '/api/system-settings', 'PUT', { user_name: 'DMG验收用户' })
      assert.equal((await api(page, '/api/system-settings')).user_name, 'DMG验收用户')
      record(`${label}: UTF-8 configuration preserved`)
      await page.screenshot({ path: path.join(reportDir, `${label}.png`) })
      await closeDesktop(browser)
      await waitFor(() => fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) }).then(() => false, () => true),
        'Bundled daemon did not stop after desktop quit')
      record(`${label}: desktop quit stops bundled daemon`)
    } finally {
      await cleanupBrowser(browser)
      if (child && child.exitCode === null) child.kill()
      await log.close()
    }
  }
  try {
    report.installerSha256 = createHash('sha256').update(await fs.readFile(options.installer)).digest('hex')
    await fs.mkdir(mount)
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path.resolve(options.installer)], { stdio: 'inherit' })
    mounted = true
    await fs.cp(path.join(mount, 'WorkStep.app'), app, { recursive: true, verbatimSymlinks: true })
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
    assert.equal(execFileSync('lipo', ['-archs', path.join(app, 'Contents/MacOS/WorkStep')], { encoding: 'utf8' }).trim(), options.machine)
    const python = path.join(app, 'Contents/Resources/backend/python/bin/python3')
    assert.equal(execFileSync(python, ['-c', 'import platform; print(platform.machine())'], { encoding: 'utf8' }).trim(), options.machine)
    record('DMG mounts, installed app signature and native Electron/Python architecture')
    await launch('first-launch')
    await launch('restart')
    report.success = true
  } catch (error) { report.error = error.stack; throw error }
  finally {
    await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    if (mounted) execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' })
  }
}
if (require.main === module) {
  const { values } = parseArgs({ options: { installer: { type: 'string' }, version: { type: 'string' }, arch: { type: 'string' } } })
  const completed = installCompletionGuard()
  runAcceptance(values).then(completed, error => { completed(); console.error(error); process.exitCode = 1 })
}
module.exports = { validateOptions }
