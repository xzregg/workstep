// Real Podman/WSL2 lifecycle, using modules extracted unchanged from a published installer.
// This is not an Electron UI or paid LLM acceptance test. Never run on a user's machine.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomBytes } = require('node:crypto')
const { createRequire } = require('node:module')
const { parseArgs } = require('node:util')
const { assertWindowsRunner, validateVersion, verifyChecksum, execute, installArguments, installCompletionGuard, parseApiResponse, validatePersistence } = require('./windows-desktop-acceptance.cjs')

function validateReleaseImage(manifest) {
  assert.match(manifest?.image || '', /^ghcr\.io\/xzregg\/workstep@sha256:[a-f0-9]{64}$/)
  assert(!manifest.localDocker, 'Acceptance requires the real published image')
  return manifest.image
}
const imageId = value => String(value || '').replace(/^sha256:/, '')
function validateContainer(container, image, releaseImage) {
  assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64')
  assert.equal(imageId(container.Image), imageId(image.Id), 'Wrong container image')
  assert(container.Config.Image === releaseImage || imageId(container.Config.Image) === imageId(image.Id))
  assert.equal(container.HostConfig.Privileged, false)
  assert.deepEqual(container.Mounts.map(mount => mount.Destination).sort(), ['/data/projects', '/root'])
}
function validateWslRegistration(entries, machine, root) {
  const registrations = entries.filter(entry => [machine, `podman-${machine}`].includes(entry.DistributionName))
  assert.equal(registrations.length, 1, 'Expected one owned WSL distribution')
  const entry = registrations[0]
  assert.equal(entry.Version, 2, 'Sandbox did not use WSL2')
  const base = path.win32.resolve(entry.BasePath.replace(/^\\\\\?\\/, '')).toLowerCase()
  const sandbox = path.win32.resolve(root).toLowerCase()
  assert(base.startsWith(sandbox + '\\'), 'WSL disk is outside the sandbox')
}
function redact(text, token) { return String(text).replaceAll(token, '[redacted]') }

async function runAcceptance(options) {
  assertWindowsRunner(process.platform, process.env)
  const version = validateVersion(options.version)
  const root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'workstep-windows-sandbox-'))
  const reportDir = path.join(process.env.RUNNER_TEMP, 'windows-sandbox-report')
  await fs.mkdir(reportDir, { recursive: true })
  const token = randomBytes(32).toString('hex')
  const report = { version, runner: process.env.RUNNER_OS, success: false, checks: [],
    gaps: ['Windows 10/11 user desktop and reboot', 'Electron sandbox settings UI and native chooser',
      'Real authenticated LLM execution', 'Local Docker image import'] }
  report.pathMode = options['ascii-sandbox-root'] ? 'ascii-sandbox-root' : 'unicode-sandbox-root'
  if (options['ascii-sandbox-root']) report.gaps.push('Chinese sandbox storage path: not exercised in this diagnostic run')
  const record = (name, details = {}) => { report.checks.push({ name, ...details }); console.log(`PASS ${name}`) }
  let manager, runtime, env, machine, podman, uninstall, run
  let phase = 'installer'
  try {
    const installer = path.resolve(options.installer)
    const data = await fs.readFile(installer)
    verifyChecksum(data, await fs.readFile(options.checksums, 'utf8'))
    report.installerSha256 = createHash('sha256').update(data).digest('hex')
    const installDir = path.join(root, '安装目录 WorkStep')
    await execute(installer, installArguments(installDir), { windowsVerbatimArguments: true, timeout: 300000 })
    uninstall = path.join(installDir, 'Uninstall WorkStep.exe')
    const asar = createRequire(path.join(__dirname, '../apps/desktop/package.json'))('@electron/asar')
    const archive = path.join(installDir, 'resources/app.asar')
    const manifest = JSON.parse(asar.extractFile(archive, 'src/sandbox-release.json'))
    const releaseImage = validateReleaseImage(manifest)
    assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version)
    report.image = releaseImage
    const extracted = path.join(root, 'published-modules')
    asar.extractAll(archive, extracted)
    const modules = options['source-modules'] ? path.join(__dirname, '../apps/desktop/src') : path.join(extracted, 'src')
    report.moduleMode = options['source-modules'] ? 'source-fix-with-published-image' : 'unmodified-published-modules'
    if (options['source-modules']) {
      report.sourceCommit = process.env.GITHUB_SHA
      report.sourceModuleHashes = Object.fromEntries(await Promise.all(
        ['sandbox.cjs', 'sandbox-runtime.cjs', 'sandbox-config.cjs', 'sandbox-docker.cjs'].map(async name =>
          [name, createHash('sha256').update(await fs.readFile(path.join(modules, name))).digest('hex')])) )
      report.gaps.push('Rebuilt fixed desktop installer: source modules used with the published image')
    }
    const { SandboxManager } = require(path.join(modules, 'sandbox.cjs'))
    run = require(path.join(modules, 'sandbox-runtime.cjs')).run
    record(`published installer checksum/version/immutable image; ${report.moduleMode}`)

    const sandbox = path.join(root, options['ascii-sandbox-root'] ? 'sandbox with spaces' : '中文沙箱 with spaces')
    const project = path.join(root, '中文项目 with spaces')
    const hostHome = path.join(root, 'host-home')
    const hostConfigFile = path.join(hostHome, '.workstep/config.json')
    await fs.mkdir(project, { recursive: true }); await fs.mkdir(path.dirname(hostConfigFile), { recursive: true })
    const hostConfig = JSON.stringify({ user: { name: 'Windows沙箱验收🙂' }, concurrency: { max_tasks: 2 } })
    await fs.writeFile(hostConfigFile, hostConfig)
    await fs.writeFile(path.join(project, 'host-marker.txt'), 'host mount 原始内容\n')
    let lastPhase
    manager = new SandboxManager({ stateDir: path.join(root, 'state'), hostHome, hostConfigFile,
      image: releaseImage, report: ({ phase }) => { if (phase !== lastPhase) console.log(`PHASE ${phase}`); lastPhase = phase } })
    report.tar = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Get-Command tar | Select-Object Source,Version | ConvertTo-Json -Compress'])
    phase = 'runtime'
    await manager.prepareRuntime({ root: sandbox })
    runtime = JSON.parse(await fs.readFile(path.join(sandbox, 'podman/runtime.json'), 'utf8'))
    assert.equal(runtime.version, '6.1.3')
    assert((await manager.status()).runtimeReady)
    record('official pinned Podman download, SHA-256 verification and Windows runtime extraction')

    phase = 'image'
    await manager.prepareImage({ root: sandbox })
    const config = (await manager.status()).settings
    env = await manager.environment(config, runtime)
    machine = `workstep-${config.id}`
    podman = args => run(runtime.executable, args, { env })
    const registrations = async () => JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $entries=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DistributionName -in @('${machine}','podman-${machine}') } | Select-Object DistributionName,Version,BasePath); ConvertTo-Json -InputObject $entries -Compress`], { timeout: 15000 }))
    validateWslRegistration(await registrations(), machine, sandbox)
    assert((await manager.status()).imageReady)
    record('real WSL2 machine, owned disk, anonymous GHCR Linux amd64 pull and verified OCI cache')
    await manager.prepareImage({ root: sandbox })
    record('second image preparation reuses verified offline OCI cache')

    phase = 'prepare'
    await manager.prepare({ root: sandbox, project, mounts: [], registeredProjects: [] })
    await manager.migrateSettings({ preferences: true })
    await manager.setEnabled(true)
    const api = async (url, endpoint, method = 'GET', body) => {
      const response = await fetch(url + endpoint, { method, headers: { 'X-WorkStep-Desktop-Token': token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) })
      return parseApiResponse(endpoint, response.status, await response.text())
    }
    async function start() {
      let snapshot
      const timer = setTimeout(() => {
        if (!manager.session) return
        snapshot = manager.session.command(['exec', machine, '/bin/sh', '-c',
          "for p in /proc/[0-9]*; do echo PID ${p##*/}; cat \"$p/comm\" \"$p/wchan\" \"$p/io\" 2>/dev/null; done; df -T /root; ls -lh /usr/local/share/workstep-runtime/base.tar; ls -ld /root/.workstep/runtime/base /root/.workstep/runtime/.base-stage.* 2>/dev/null; curl --max-time 3 -sS http://127.0.0.1:8765/api/health || true"],
        { captureCombined: true, timeout: 15000 }).then(async text => {
          await fs.writeFile(path.join(reportDir, `startup-${phase}.log`), redact(text, token))
        }).catch(error => { report.startupDiagnosticError = redact(error.message, token) })
      }, 30000)
      let url
      try { url = await manager.start(0, token) }
      finally { clearTimeout(timer); await snapshot }
      const health = await api(url, '/api/health')
      assert.equal(health.status, 'ok'); assert.equal(health.version, version)
      const denied = await fetch(url + '/api/project/list', { signal: AbortSignal.timeout(5000) })
      assert([401, 403].includes(denied.status), 'Business API accepts unauthenticated host requests')
      const [container] = JSON.parse(await manager.session.command(['inspect', `workstep-${config.id}`]))
      const [image] = JSON.parse(await manager.session.command(['image', 'inspect', container.Image]))
      validateContainer(container, image, releaseImage)
      assert.equal((await manager.settings()).releaseImage, releaseImage)
      assert((await fetch(url + '/', { signal: AbortSignal.timeout(5000) })).ok)
      record('container health/version, real host port forwarding, frontend and authenticated API boundary')
      return url
    }
    phase = 'first-start'
    let url = await start()
    assert.equal((await api(url, '/api/system-settings')).user_name, 'Windows沙箱验收🙂')
    await assert.rejects(() => api(url, '/api/project/init', 'POST', { name: '越界项目', path: '/tmp/outside-project' }))
    record('preference migration, host config unchanged and project directory boundary rejection')
    await manager.session.command(['exec', `workstep-${config.id}`, 'python', '-c',
      "from pathlib import Path; p=Path('/data/projects/host-marker.txt'); assert '原始内容' in p.read_text(); Path('/data/projects/container-marker.txt').write_text('容器写入🙂',encoding='utf-8')"])
    assert.equal(await fs.readFile(path.join(project, 'container-marker.txt'), 'utf8'), '容器写入🙂')
    record('Chinese/space Windows project bind mount, host-to-container and container-to-host writes')
    const created = await api(url, '/api/project/init', 'POST', { name: 'Windows沙箱验收', path: '/data/projects' })
    const query = `?project_id=${encodeURIComponent(created.id)}`
    const workflow = await api(url, '/api/workflow/create' + query, 'POST', { name: '沙箱验收流程', is_default: true })
    const title = 'Windows沙箱持久化验收🙂'
    const task = await api(url, '/api/task/create' + query, 'POST', { title, auto_start: false, workflow_id: workflow.id })
    const memory = '# 沙箱验收\n\n中文与表情🙂，重启后保留。\n'
    await api(url, '/api/fs/memory' + query, 'PUT', { content: memory })
    const fixture = { projectId: created.id, taskId: task.id, title, memory }
    const checkData = async () => validatePersistence(fixture, await api(url, '/api/project/list'),
      await api(url, `/api/task/${task.id}${query}`), await api(url, '/api/fs/memory' + query))
    await checkData(); record('real project/workflow/task creation and memory persistence without paid LLM')
    phase = 'restart'
    const disk = await registrations()
    await manager.stop()
    assert(!(await manager.status()).running)
    assert(JSON.parse(await podman(['machine', 'list', '--format=json'])).every(item => (item.Name || item.name) !== machine || !item.Running))
    record('sandbox stop shuts down its owned Podman/WSL machine')
    url = await start()
    await checkData()
    assert.deepEqual(await registrations(), disk)
    assert.equal(await fs.readFile(hostConfigFile, 'utf8'), hostConfig)
    record('WSL machine/container restart preserves Home/config/project/task/memory and disk location')
    phase = 'remove'
    await manager.stop(); await manager.setEnabled(false)
    await fs.writeFile(path.join(reportDir, 'sandbox.log'), redact(await manager.readLogs(), token))
    const memoryBytes = await fs.readFile(path.join(project, '.workstep/MEMORY.md'))
    await manager.remove()
    assert.deepEqual(await registrations(), [])
    assert.equal(await fs.access(sandbox).then(() => true, () => false), false, 'Owned sandbox directory remains after removal')
    assert.deepEqual(await fs.readFile(path.join(project, '.workstep/MEMORY.md')), memoryBytes)
    assert(await fs.stat(path.join(project, '.workstep/workstep.db')))
    assert.equal(await fs.readFile(hostConfigFile, 'utf8'), hostConfig)
    record('owned sandbox cleanup removes WSL registration and retains original host/project data')
    report.success = true
  } catch (error) {
    report.failedPhase = phase; report.error = redact(error.stack, token)
    console.error(report.error)
    if (phase === 'first-start' && podman && machine) {
      // Product startup stops its VM after failure. Reopen only this owned VM
      // for read-only diagnostics; do not turn a failed startup into a pass.
      try {
        await podman(['machine', 'start', '--update-connection=false', machine])
        const command = args => podman(['--connection', machine, ...args])
        const name = machine
        const [container] = JSON.parse(await command(['inspect', name]))
        report.containerFailure = { State: container.State, Mounts: container.Mounts,
          Ports: container.NetworkSettings?.Ports }
        await fs.writeFile(path.join(reportDir, 'container-failure.log'), redact(await run(runtime.executable,
          ['--connection', machine, 'logs', '--tail=200', name], { env, captureCombined: true }), token))
      } catch (diagnosticError) { report.diagnosticError = redact(diagnosticError.message, token) }
    }
  } finally {
    if (manager && !(report.success)) {
      await fs.writeFile(path.join(reportDir, 'sandbox.log'), redact(await manager.readLogs().catch(error => error.message), token))
      try { await manager.stop(); await manager.setEnabled(false); await manager.remove() }
      catch (error) { report.cleanupError = redact(error.message, token) }
    }
    if (uninstall) await execute(uninstall, ['/S', '/currentuser']).catch(error => { report.uninstallError = redact(error.message, token); report.success = false })
    await fs.writeFile(path.join(reportDir, 'report.json'), redact(JSON.stringify(report, null, 2), token) + '\n')
  }
  if (!report.success) throw new Error(`Windows sandbox acceptance failed in ${report.failedPhase || 'cleanup'}; see report artifact`)
}
if (require.main === module) {
  const { values } = parseArgs({ options: { ...Object.fromEntries(['installer', 'version', 'checksums'].map(name => [name, { type: 'string' }])),
    'ascii-sandbox-root': { type: 'boolean', default: false }, 'source-modules': { type: 'boolean', default: false } } })
  const completed = installCompletionGuard()
  runAcceptance(values).then(completed, error => { completed(); console.error(error); process.exitCode = 1 })
}
module.exports = { validateReleaseImage, validateContainer, validateWslRegistration, redact }
