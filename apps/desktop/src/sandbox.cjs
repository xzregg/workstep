const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { run, installRuntime } = require('./sandbox-runtime.cjs')
const { listDockerImages, importDockerImage } = require('./sandbox-docker.cjs')

const IMPORTS = { codex: ['.codex'], claude: ['.claude', '.claude.json'], agents: ['.agents'] }
const contains = (parent, child) => child === parent || (!path.relative(parent, child).startsWith('..' + path.sep) && !path.isAbsolute(path.relative(parent, child)) && path.relative(parent, child) !== '..')
async function canonical(value) {
  const absolute = path.resolve(value)
  try { return await fs.realpath(absolute) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(absolute)
    if (parent === absolute) throw error
    return path.join(await canonical(parent), path.basename(absolute))
  }
}
async function validateSettings(input) {
  if (!input || typeof input.root !== 'string' || !input.root.trim() || typeof input.project !== 'string' || !input.project.trim()) throw new Error('请选择沙箱目录和项目根目录')
  if (!path.isAbsolute(input.root) || !path.isAbsolute(input.project)) throw new Error('目录必须是绝对路径')
  const root = await canonical(input.root), project = await canonical(input.project)
  if (root === path.parse(root).root || root === await canonical(os.homedir())) throw new Error('请选择独立的沙箱目录')
  const mounts = input.mounts ?? []
  if (!Array.isArray(mounts) || mounts.length > 32) throw new Error('额外挂载配置无效')
  const normalized = []
  const targets = ['/data/projects']
  for (const mount of mounts) {
    if (typeof mount?.source !== 'string' || !path.isAbsolute(mount.source) || typeof mount.target !== 'string' || !/^\/data\/projects\/[A-Za-z0-9_.-]+$/.test(mount.target) || ['.', '..'].includes(path.posix.basename(mount.target))) throw new Error('额外挂载必须使用独立的项目路径')
    if (targets.includes(mount.target)) throw new Error('项目挂载目标重复')
    targets.push(mount.target)
    normalized.push({ source: await canonical(mount.source), target: mount.target })
  }
  for (const source of [project, ...normalized.map(mount => mount.source)]) {
    if (contains(root, source) || contains(source, root)) throw new Error('沙箱目录与项目目录不能重叠')
    if (!(await fs.stat(source)).isDirectory()) throw new Error('项目目录不存在')
    if (source.includes(',') || source.includes('\n')) throw new Error('项目目录不能包含逗号或换行')
  }
  if (root.includes(',') || root.includes('\n')) throw new Error('沙箱目录不能包含逗号或换行')
  return { root, project, mounts: normalized, id: createHash('sha256').update(root).digest('hex').slice(0, 16) }
}
function windowsPath(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value)
  if (!match) throw new Error('Windows 沙箱仅支持本地盘符目录')
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`
}
function guestMounts(config, platform) {
  // Fedora CoreOS makes /mnt a symlink; systemd mount units need /var/mnt.
  if (platform === 'darwin') return [
    { source: '/var/mnt/workstep-home', target: '/root' },
    { source: '/var/mnt/workstep-projects', target: '/data/projects' },
    ...config.mounts.map((mount, i) => ({ source: `/var/mnt/workstep-extra-${i}`, target: mount.target })),
  ]
  const transform = platform === 'win32' ? windowsPath : value => value
  return [{ source: transform(path.join(config.root, 'home')), target: '/root' }, { source: transform(config.project), target: '/data/projects' }, ...config.mounts.map(mount => ({ source: transform(mount.source), target: mount.target }))]
}
function containerArgs(config, platform, port, token, managedEnv = {}) {
  const args = ['run', '--detach', '--name', `workstep-${config.id}`, '--label', `com.workstep.sandbox=${config.id}`, '--publish', `127.0.0.1:${port || ''}:8765`]
  if (platform === 'linux') args.push('--userns=keep-id:uid=0,gid=0', '--cgroups=disabled')
  for (const mount of guestMounts(config, platform)) args.push('--mount', `type=bind,source=${mount.source},target=${mount.target}`)
  if (config.compatibility) args.push('--cap-add=SYS_ADMIN', '--security-opt=seccomp=unconfined')
  args.push('--env', `WORKSTEP_DESKTOP_TOKEN=${token}`, '--env', 'WORKSTEP_DESKTOP_RUNTIME=1')
  for (const [key, value] of Object.entries(managedEnv)) {
    if (key.startsWith('WORKSTEP_') && typeof value === 'string') args.push('--env', `${key}=${value}`)
  }
  if (managedEnv.WORKSTEP_MANAGED_BUNDLE_DIR) {
    const host = path.join(config.root, 'desktop/managed-gateway')
    const source = platform === 'darwin' ? '/var/mnt/workstep-managed' : platform === 'win32' ? windowsPath(host) : host
    args.push('--mount', `type=bind,source=${source},target=/usr/local/share/workstep-managed,readonly`)
  }
  args.push(config.image)
  return args
}

class SandboxManager {
  constructor({ stateDir, platform = process.platform, arch = process.arch, hostHome = os.homedir(), install = installRuntime, execute = run, image, report = () => {} }) {
    Object.assign(this, { stateDir, platform, arch, hostHome, install, execute, image, report })
    this.phase = 'idle'; this.progress = null; this.error = null; this.busy = false; this.running = false
  }
  async settings() {
    try { return JSON.parse(await fs.readFile(path.join(this.stateDir, 'sandbox.json'), 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { enabled: false, root: '', project: '', mounts: [] }
    }
  }
  dockerImages() { return listDockerImages(this.execute, this.platform, this.arch) }
  compatibleImage(settings) {
    return settings.dockerImage ? /^sha256:[a-f0-9]{64}$/.test(settings.dockerImage) && /^sha256:[a-f0-9]{64}$/.test(settings.image) : settings.image === this.image
  }
  async save(settings) {
    await fs.mkdir(this.stateDir, { recursive: true })
    const file = path.join(this.stateDir, 'sandbox.json')
    await fs.writeFile(file + '.tmp', JSON.stringify(settings, null, 2), { mode: 0o600 })
    await fs.rename(file + '.tmp', file)
  }
  update(phase, progress = null) {
    this.phase = phase; this.progress = progress; this.report({ phase, progress })
    if (this.logFile && phase !== 'download') {
      this.logWrite = (this.logWrite || Promise.resolve()).then(() => fs.appendFile(this.logFile,
        JSON.stringify({ time: new Date().toISOString(), phase, error: this.error }) + '\n', { mode: 0o600 })).catch(() => {})
    }
  }
  async status() {
    const active = await this.settings()
    let settings = active
    if (!active.root) {
      try { settings = { ...JSON.parse(await fs.readFile(path.join(this.stateDir, 'sandbox-pending.json'), 'utf8')), enabled: false, prepared: false } } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return { settings, onlineImage: Boolean(this.image), phase: this.phase, progress: this.progress, error: this.error, running: this.running, supported: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'].includes(`${this.platform}-${this.arch}`) }
  }
  async exclusive(operation) {
    if (this.busy) throw new Error('沙箱操作正在进行，请稍候')
    this.busy = true; this.error = null
    try { return await operation() } catch (error) { this.error = error.message; this.update('error'); throw error } finally { this.busy = false }
  }
  async claimRoot(config) {
    await fs.mkdir(config.root, { recursive: true })
    const marker = path.join(config.root, 'desktop', 'owner.json')
    let owner
    try { owner = JSON.parse(await fs.readFile(marker, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (owner && owner.id !== config.id) throw new Error('该目录属于另一个沙箱')
    let preserveHome = owner?.preserveHome === true
    if (!owner) {
      const entries = await fs.readdir(config.root)
      if (entries.some(name => !['home', '.DS_Store'].includes(name))) throw new Error('首次开启请选择空目录，或仅包含已有 home 的目录；其他文件不会自动接管')
      if (entries.includes('home')) {
        const home = await fs.lstat(path.join(config.root, 'home'))
        if (!home.isDirectory() || home.isSymbolicLink()) throw new Error('已有 Home 必须是真实目录，不能是文件或符号链接')
        preserveHome = true
      }
    }
    for (const directory of ['home', 'desktop', 'desktop/managed-gateway', 'podman/config', 'podman/data', 'podman/cache']) {
      const destination = path.join(config.root, directory)
      if (!contains(config.root, await canonical(destination))) throw new Error('沙箱内部目录不能指向外部位置')
      await fs.mkdir(destination, { recursive: true })
    }
    this.logFile = path.join(config.root, 'desktop/sandbox.log')
    await fs.writeFile(marker, JSON.stringify({ id: config.id, project: config.project, mounts: config.mounts, preserveHome }), { mode: 0o600 })
  }
  async environment(config, runtime) {
    const root = path.join(config.root, 'podman')
    const runtimeDir = path.join(os.tmpdir(), `workstep-podman-${config.id}`)
    await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 })
    const runtimeStat = await fs.lstat(runtimeDir)
    if (runtimeStat.isSymbolicLink() || (process.getuid && runtimeStat.uid !== process.getuid())) throw new Error('沙箱临时运行目录归属无效')
    await fs.chmod(runtimeDir, 0o700)
    const configFile = path.join(root, 'config', 'containers.conf')
    const helpers = [...new Set([path.dirname(runtime.executable), ...(runtime.helpers || [])])]
    const engine = `[engine]\ncgroup_manager="cgroupfs"\n${runtime.conmon ? `conmon_path=${JSON.stringify([runtime.conmon])}\n` : ''}helper_binaries_dir=${JSON.stringify(helpers)}\nevents_logger="file"\n${runtime.crun ? `runtime=${JSON.stringify(runtime.crun)}\n` : ''}`
    await fs.writeFile(configFile, `${engine}\n[machine]\nvolumes=[]\nprovider=${JSON.stringify(this.platform === 'darwin' ? 'applehv' : 'wsl')}\n`, { mode: 0o600 })
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_RUNTIME_DIR: runtimeDir, CONTAINERS_CONF: configFile, CONTAINERS_CONF_OVERRIDE: configFile, CONTAINERS_STORAGE_CONF: path.join(root, 'config/storage.conf'), PODMAN_CONNECTIONS_CONF: path.join(root, 'config/connections.json'), REGISTRY_AUTH_FILE: path.join(root, 'config/auth.json'), PATH: helpers.join(path.delimiter) + path.delimiter + process.env.PATH }
    for (const key of ['CONTAINER_HOST', 'CONTAINER_CONNECTION', 'DOCKER_HOST', 'CONTAINER_SSHKEY']) delete env[key]
    await fs.writeFile(env.CONTAINERS_STORAGE_CONF, `[storage]\ndriver="vfs"\ngraphroot=${JSON.stringify(path.join(root, 'data/storage'))}\nrunroot=${JSON.stringify(path.join(runtimeDir, 'storage'))}\n`, { mode: 0o600 })
    await fs.writeFile(path.join(root, 'config/policy.json'), JSON.stringify({ default: [{ type: 'insecureAcceptAnything' }] }))
    return env
  }
  async setup(config) {
    if (!(await this.status()).supported) throw new Error('当前系统或架构不支持桌面沙箱')
    await this.claimRoot(config)
    this.update('download')
    const runtime = await this.install(config.root, this.platform, this.arch, progress => this.update('download', progress))
    const env = await this.environment(config, runtime)
    const podman = (args, options = {}) => this.execute(runtime.executable, args, { env, ...options })
    this.update('machine')
    if (this.platform === 'win32') {
      try { await this.execute('wsl.exe', ['--status'], { timeout: 15000 }) } catch { throw new Error('请先启用 Windows WSL2 和虚拟化，再重试开启沙箱：https://learn.microsoft.com/windows/wsl/install') }
    }
    const machine = `workstep-${config.id}`
    try {
      if (this.platform !== 'linux') {
        let machines = JSON.parse(await podman(['machine', 'list', '--format=json']))
        let existing = machines.find(item => (item.Name || item.name) === machine)
        if (!existing) {
          const args = ['machine', 'init', '--cpus=2', '--memory=2048', '--disk-size=20']
          if (this.platform === 'win32') args.push('--update-connection=false')
          if (this.platform === 'darwin') {
            args.push('--volume', `${path.join(config.root, 'home')}:/var/mnt/workstep-home`, '--volume', `${config.project}:/var/mnt/workstep-projects`, '--volume', `${path.join(config.root, 'desktop/managed-gateway')}:/var/mnt/workstep-managed`)
            config.mounts.forEach((mount, i) => args.push('--volume', `${mount.source}:/var/mnt/workstep-extra-${i}`))
          }
          args.push(machine); await podman(args)
          if (this.platform === 'win32') {
            // WSL registrations are system state; verify that its actual disk stays
            // under our sandbox rather than the user's global WSL storage.
            await this.execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
              String.raw`$ErrorActionPreference='Stop'; $names=@($env:WORKSTEP_VM_NAME,('podman-'+$env:WORKSTEP_VM_NAME)); $d=Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $names -contains $_.DistributionName }; if (!$d) { throw '无法确认沙箱 WSL 注册信息' }; foreach ($item in $d) { $base=[IO.Path]::GetFullPath($item.BasePath.Replace('\\?\','')).TrimEnd('\'); $root=[IO.Path]::GetFullPath($env:WORKSTEP_SANDBOX_ROOT).TrimEnd('\'); if (!$base.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'WSL 磁盘未保存在沙箱目录中，请删除该沙箱并检查 Podman 配置' } }`],
              { env: { ...env, WORKSTEP_VM_NAME: machine, WORKSTEP_SANDBOX_ROOT: config.root }, timeout: 15000 })
          }
        } else {
          const recorded = JSON.parse(await fs.readFile(path.join(config.root, 'desktop/machine-mounts.json'), 'utf8').catch(() => 'null'))
          if (JSON.stringify(recorded) !== JSON.stringify({ layout: 2, project: config.project, mounts: config.mounts })) {
            await podman(['machine', 'stop', machine]).catch(() => {})
            await podman(['machine', 'rm', '--force', machine])
            // Recreate on next attempt rather than run with outdated host shares.
            return this.setup(config)
          }
        }
        await fs.writeFile(path.join(config.root, 'desktop/machine-mounts.json'), JSON.stringify({ layout: 2, project: config.project, mounts: config.mounts }))
        machines = JSON.parse(await podman(['machine', 'list', '--format=json']))
        existing = machines.find(item => (item.Name || item.name) === machine)
        if (!(existing?.Running || existing?.running)) await podman(['machine', 'start', ...(this.platform === 'win32' ? ['--update-connection=false'] : []), machine])
      }
      const command = (args, options) => podman(this.platform === 'linux' ? ['--signature-policy', path.join(config.root, 'podman/config/policy.json'), ...args] : ['--connection', machine, ...args], options)
      try { await command(['info', '--format=json']) } catch (error) {
        if (this.platform === 'linux') error.message += '\nLinux 需启用用户命名空间并配置 subuid/subgid，安装 uidmap、nsenter；AppArmor/SELinux 也需允许此运行时。'
        throw error
      }
      return { command, podman, runtime, env, machine }
    } catch (error) {
      if (this.platform !== 'linux') await podman(['machine', 'stop', machine]).catch(() => {})
      throw error
    }
  }
  async prepare(input) {
    return this.exclusive(async () => {
      const previous = await this.settings()
      const config = { ...await validateSettings(input), compatibility: input.compatibility === true, dockerImage: input.dockerImage || null }
      if (config.dockerImage && !/^sha256:[a-f0-9]{64}$/.test(config.dockerImage)) throw new Error('无效的 Docker 镜像 ID')
      const image = config.dockerImage || this.image
      if (typeof image !== 'string' || !image.length) throw new Error('当前版本未配置在线沙箱镜像，请扫描并选择本地 Docker 中的 WorkStep 镜像')
      if (this.platform !== 'win32' && [config.root, config.project, ...config.mounts.map(m => m.source)].some(value => value.includes(':'))) throw new Error('沙箱挂载目录不能包含冒号')
      if (previous.root && previous.root !== config.root) throw new Error('请先删除旧沙箱，或继续使用原沙箱目录')
      await fs.mkdir(this.stateDir, { recursive: true })
      await fs.writeFile(path.join(this.stateDir, 'sandbox-pending.json'), JSON.stringify(config), { mode: 0o600 })
      const session = await this.setup(config)
      try {
        this.update('image')
        if (config.dockerImage) config.image = await importDockerImage({ root: config.root, id: image, execute: this.execute, command: session.command, platform: this.platform, arch: this.arch })
        else { await session.command(['pull', image]); config.image = image }
        await this.save({ ...config, enabled: false, prepared: true })
        await fs.rm(path.join(this.stateDir, 'sandbox-pending.json'), { force: true })
        this.update('ready')
        return this.status()
      } finally {
        // Do not leave a preparation-only VM running beside the native backend.
        if (this.platform !== 'linux') await session.podman(['machine', 'stop', session.machine])
      }
    })
  }
  async start(port, token, managedEnv = {}) {
    return this.exclusive(async () => {
      const settings = await this.settings()
      const config = { ...settings, ...await validateSettings(settings) }
      if (!config.enabled || !config.prepared || !this.compatibleImage(config)) throw new Error('沙箱需要先完成当前版本的初始化')
      const session = await this.setup(config)
      this.session = session; this.activeConfig = config; this.redactions = [token]
      this.update('starting')
      try {
        const containers = JSON.parse(await session.command(['ps', '-a', '--filter', `label=com.workstep.sandbox=${config.id}`, '--format=json']))
        for (const item of containers) await session.command(['rm', '--force', item.Id || item.ID])
        try {
          await session.command(containerArgs(config, this.platform, port, token, managedEnv))
        } catch (error) {
          // Podman may leave a created container after publishing fails.
          // Retry only port conflicts, preserving other startup failures.
          if (!port || !/address already in use|port is already allocated|port.*already in use/i.test(error.message)) throw error
          await session.command(['rm', '--force', `workstep-${config.id}`]).catch(() => {})
          await session.command(containerArgs(config, this.platform, 0, token, managedEnv))
        }
        const mapping = await session.command(['port', `workstep-${config.id}`, '8765/tcp'])
        const matched = /127\.0\.0\.1:(\d+)/.exec(mapping)
        if (!matched) throw new Error('无法取得沙箱后台端口')
        const url = `http://127.0.0.1:${matched[1]}`
        const deadline = Date.now() + 90000
        let healthy = false
        while (Date.now() < deadline) {
          try {
            const response = await fetch(`${url}/api/health`, { headers: { 'X-WorkStep-Desktop-Token': token }, signal: AbortSignal.timeout(2000) })
            if (response.ok && (await response.json()).status === 'ok') { healthy = true; break }
          } catch { /* startup still in progress */ }
          await delay(500)
        }
        if (!healthy) throw new Error('沙箱后台健康检查超时，请查看容器日志')
        this.running = true; this.update('running')
        return url
      } catch (error) {
        error.message = error.message.replaceAll(token, '[redacted]')
        await this.captureLogs().catch(() => {})
        await this.stop().catch(() => {})
        throw error
      }
    })
  }
  async captureLogs() {
    if (!this.session || !this.activeConfig) return
    let logs = await this.session.command(['logs', '--tail=200', `workstep-${this.activeConfig.id}`], { captureCombined: true, timeout: 10000 })
    for (const secret of this.redactions || []) logs = logs.replaceAll(secret, '[redacted]')
    await fs.writeFile(path.join(this.activeConfig.root, 'desktop/daemon.log'), logs, { mode: 0o600 })
  }
  async stop() {
    if (this.session && this.activeConfig) {
      await this.captureLogs().catch(() => {})
      const { command, podman, machine } = this.session
      const containers = JSON.parse(await command(['ps', '-a', '--filter', `label=com.workstep.sandbox=${this.activeConfig.id}`, '--format=json']))
      for (const container of containers) await command(['stop', '--time=10', container.Id || container.ID])
      if (this.platform !== 'linux') await podman(['machine', 'stop', machine])
      this.session = null; this.activeConfig = null
    }
    this.running = false
  }
  async setEnabled(enabled) {
    return this.exclusive(async () => {
      if (typeof enabled !== 'boolean') throw new Error('模式无效')
      const settings = await this.settings()
      if (enabled && (!settings.prepared || !this.compatibleImage(settings))) throw new Error('请先准备当前版本的沙箱')
      await this.save({ ...settings, enabled })
      return this.status()
    })
  }
  async importConfig(kind) {
    return this.exclusive(async () => {
      if (!IMPORTS[kind]) throw new Error('不支持的配置类型')
      if (this.running) throw new Error('请关闭沙箱后再导入配置')
      const settings = (await this.status()).settings
      if (!settings.root) throw new Error('请先准备沙箱')
      await this.claimRoot(settings)
      const backup = path.join(settings.root, 'desktop/backups', `${Date.now()}-${kind}`)
      const stage = await fs.mkdtemp(path.join(settings.root, 'home', `.import-${kind}-`))
      const entries = [], installed = [], backedUp = []
      try {
        for (const name of IMPORTS[kind]) {
          const source = path.join(this.hostHome, name)
          try {
            const stat = await fs.lstat(source)
            if (stat.isSymbolicLink()) throw new Error('配置来源不能是符号链接')
          } catch (error) { if (error.code === 'ENOENT') continue; throw error }
          await fs.cp(source, path.join(stage, name), { recursive: true, dereference: false, filter: async file => {
            const stat = await fs.lstat(file)
            return !stat.isSymbolicLink() && !stat.isSocket() && !['.tmp', 'cache', 'node_modules'].includes(path.basename(file)) && !/\.(lock|sock)$/.test(file)
          } })
          entries.push(name)
        }
        if (!entries.length) throw new Error('宿主机没有对应的引擎配置')
        for (const name of entries) {
          const target = path.join(settings.root, 'home', name)
          if (await fs.lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) {
            await fs.mkdir(backup, { recursive: true })
            await fs.rename(target, path.join(backup, name)); backedUp.push(name)
          }
          await fs.rename(path.join(stage, name), target); installed.push(name)
        }
      } catch (error) {
        for (const name of installed) await fs.rm(path.join(settings.root, 'home', name), { recursive: true, force: true })
        for (const name of backedUp) await fs.rename(path.join(backup, name), path.join(settings.root, 'home', name))
        throw error
      } finally { await fs.rm(stage, { recursive: true, force: true }) }
      return this.status()
    })
  }
  async remove() {
    return this.exclusive(async () => {
      const settings = (await this.status()).settings
      if (!settings.root) return this.status()
      const config = await validateSettings(settings)
      const owner = JSON.parse(await fs.readFile(path.join(config.root, 'desktop/owner.json'), 'utf8'))
      if (owner.id !== config.id || !Array.isArray(owner.mounts)) throw new Error('无法确认沙箱目录归属')
      for (const mount of [{ source: owner.project }, ...owner.mounts]) if (contains(config.root, await canonical(mount.source))) throw new Error('沙箱内存在项目数据，拒绝删除')
      await this.claimRoot(config)
      await this.stop()
      const record = JSON.parse(await fs.readFile(path.join(config.root, 'podman/runtime.json'), 'utf8').catch(() => 'null'))
      if (record) {
        const env = await this.environment(config, record)
        const invoke = args => this.execute(record.executable, args, { env })
        if (this.platform !== 'linux') {
          const machines = JSON.parse(await invoke(['machine', 'list', '--format=json']))
          if (machines.some(item => (item.Name || item.name) === `workstep-${config.id}`)) await invoke(['machine', 'rm', '--force', `workstep-${config.id}`])
        } else {
          const containers = JSON.parse(await invoke(['ps', '-a', '--filter', `label=com.workstep.sandbox=${config.id}`, '--format=json']))
          for (const item of containers) await invoke(['rm', '--force', item.Id || item.ID])
          const storage = path.join(config.root, 'podman/data/storage')
          if (!contains(config.root, await canonical(storage))) throw new Error('容器存储不能指向沙箱外部')
          try { await fs.rm(storage, { recursive: true, force: true }) } catch (error) {
            if (!['EACCES', 'EPERM'].includes(error.code)) throw error
            // Rootless image files can belong to subordinate UIDs.
            await invoke(['unshare', 'rm', '-rf', '--', storage])
          }
        }
      }
      await this.logWrite
      this.logFile = null
      if (owner.preserveHome === true) {
        // Compose Home was adopted, not created by this desktop sandbox.
        await fs.rm(path.join(config.root, 'podman'), { recursive: true })
        await fs.rm(path.join(config.root, 'desktop'), { recursive: true })
      } else await fs.rm(config.root, { recursive: true })
      await fs.rm(path.join(os.tmpdir(), `workstep-podman-${config.id}`), { recursive: true, force: true })
      await fs.rm(path.join(this.stateDir, 'sandbox-pending.json'), { force: true })
      await this.save({ enabled: false, root: '', project: '', mounts: [] })
      this.update('idle')
      return this.status()
    })
  }
}
module.exports = { SandboxManager, validateSettings, containerArgs, windowsPath }
