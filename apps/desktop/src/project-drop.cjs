const fs = require('node:fs/promises')
const path = require('node:path')

async function resolveDroppedDirectory(input, manager) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) throw new Error('文件夹必须是绝对路径')
  const directory = await fs.realpath(input)
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('请拖入文件夹')
  if (!manager?.running) return directory
  const config = manager.activeConfig || (await manager.status()).settings
  const mounts = [{ source: config.project, target: '/data/projects' }, ...(config.mounts || [])]
  // Resolve mount aliases too, so symlinked host project roots remain usable.
  const resolved = await Promise.all(mounts.map(async mount => ({ ...mount, source: await fs.realpath(mount.source) })))
  for (const mount of resolved.sort((a, b) => b.source.length - a.source.length)) {
    const relative = path.relative(mount.source, directory)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    return path.posix.join(mount.target, ...relative.split(path.sep))
  }
  throw new Error('此文件夹尚未挂载到沙箱，请先在沙箱设置中添加项目挂载，或关闭沙箱后重试')
}

module.exports = { resolveDroppedDirectory }
