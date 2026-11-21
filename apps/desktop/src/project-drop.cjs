const fs = require('node:fs/promises')
const path = require('node:path')

async function resolveDroppedDirectory(input, manager) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) throw new Error('The folder must be an absolute path')
  const directory = await fs.realpath(input)
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('Please drag and drop a folder')
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
  throw new Error('This folder is not mounted to the sandbox. Please add project mount in sandbox settings, or retry after closing the sandbox.')
}

module.exports = { resolveDroppedDirectory }
