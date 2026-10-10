const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execute = promisify(execFile)
const APPS = [
 ['vscode', 'VS Code', 'Visual Studio Code', ['code']],
 ['sublime', 'Sublime Text', 'Sublime Text', ['subl']],
 ['file_manager', '文件管理器', '', []],
 ['terminal', 'Terminal', 'Terminal', ['wt', 'x-terminal-emulator']],
 ['iterm', 'iTerm2', 'iTerm', []],
 ['intellij', 'IntelliJ IDEA', 'IntelliJ IDEA', ['idea']],
 ['pycharm', 'PyCharm', 'PyCharm', ['pycharm']],
]
async function exists(file) { try { await fs.access(file); return true } catch { return false } }
async function findCommand(commands, platform) {
 for (const command of commands) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
   for (const suffix of platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) {
    const file = path.join(directory, command + suffix)
    if (await exists(file)) return file
   }
  }
 }
 return null
}
async function directoryOpeners({ platform = process.platform, exists: check = exists } = {}) {
 return Promise.all(APPS.map(async ([id, label, app, commands]) => {
  const available = id === 'file_manager' || (platform === 'darwin'
   ? (await Promise.all(['/Applications', path.join(os.homedir(), 'Applications'), '/System/Applications', '/System/Applications/Utilities'].map(root => check(path.join(root, app + '.app'))))).some(Boolean)
   : Boolean(await findCommand(commands, platform)))
  if (id === 'file_manager') label = platform === 'darwin' ? 'Finder' : platform === 'win32' ? '文件资源管理器' : label
  return { id, label, available }
 }))
}
function mapSandboxPath(input, config) {
 if (typeof input !== 'string' || !path.posix.isAbsolute(input) || input.includes('\0') || input.split('/').includes('..')) throw new Error('沙箱目录路径无效')
 const normalized = path.posix.normalize(input)
 const mounts = [{ source: config.project, target: '/data/projects' }, { source: path.join(config.root, 'home'), target: '/root' }, ...(config.mounts || [])]
 const mount = mounts.sort((a, b) => b.target.length - a.target.length).find(m => normalized === m.target || normalized.startsWith(m.target + '/'))
 if (!mount) throw new Error('此沙箱目录没有对应的宿主机挂载')
 return path.join(mount.source, path.posix.relative(mount.target, normalized))
}
function openCommand(platform, id, directory, command) {
 const app = APPS.find(item => item[0] === id)
 if (!app) throw new Error('未知目录打开应用')
 if (platform === 'darwin') return id === 'file_manager' ? ['open', directory] : ['open', '-a', app[2], directory]
 if (!command) throw new Error('宿主机未安装所选应用')
 if (id === 'terminal') return [command, platform === 'win32' ? '-d' : '--working-directory', directory]
 return [command, directory]
}
async function openDirectory(input, manager, shell) {
 if (!input || typeof input.path !== 'string' || !path.isAbsolute(input.path)) throw new Error('目录必须是绝对路径')
 const status = await manager.status()
 let directory = status.running ? mapSandboxPath(input.path, manager.activeConfig || status.settings) : input.path
 directory = await fs.realpath(directory)
 if (!(await fs.stat(directory)).isDirectory()) directory = path.dirname(directory)
 const id = input.opener || 'file_manager'
 const opener = (await directoryOpeners()).find(item => item.id === id && item.available)
 if (!opener) throw new Error('宿主机未安装所选应用')
 if (id === 'file_manager') {
  const error = await shell.openPath(directory)
  if (error) throw new Error(error)
 } else {
  const app = APPS.find(item => item[0] === id)
  const command = openCommand(process.platform, id, directory, await findCommand(app[3], process.platform))
  await execute(command[0], command.slice(1), { timeout: 15000, windowsHide: true })
 }
 return { opened: true, path: directory }
}
module.exports = { directoryOpeners, mapSandboxPath, openCommand, openDirectory }
