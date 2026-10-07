const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')

async function dockerExecutable(execute, platform) {
  const candidates = platform === 'darwin'
    ? ['/Applications/Docker.app/Contents/Resources/bin/docker', path.join(os.homedir(), '.docker/bin/docker'), 'docker']
    : platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker/Docker/resources/bin/docker.exe'), 'docker.exe'] : ['docker']
  for (const candidate of candidates) {
    try { await execute(candidate, ['--version'], { timeout: 10000 }); return candidate } catch { /* try next installation */ }
  }
  throw new Error('未找到 Docker，请安装并启动 Docker 后重试')
}
function compatible(image, arch) {
  return image.Os === 'linux' && image.Architecture === (arch === 'x64' ? 'amd64' : arch)
    && image.Config?.Entrypoint?.includes('/usr/local/bin/workstep-entrypoint')
}
async function listDockerImages(execute, platform, arch) {
  try {
    const docker = await dockerExecutable(execute, platform)
    const ids = [...new Set((await execute(docker, ['image', 'ls', '--quiet', '--no-trunc'], { timeout: 15000 })).split(/\s+/).filter(id => /^sha256:[a-f0-9]{64}$/.test(id)))]
    const images = []
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = JSON.parse(await execute(docker, ['image', 'inspect', ...ids.slice(offset, offset + 50)], { timeout: 15000 }))
      for (const image of batch) if (compatible(image, arch)) images.push({ id: image.Id, tags: image.RepoTags || [], size: image.Size || 0 })
    }
    return { images, error: null }
  } catch (error) { return { images: [], error: error.message } }
}
async function importDockerImage({ root, id, execute, command, platform, arch }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(id || '')) throw new Error('无效的 Docker 镜像 ID')
  const docker = await dockerExecutable(execute, platform)
  const [image] = JSON.parse(await execute(docker, ['image', 'inspect', id], { timeout: 15000 }))
  if (image?.Id !== id || !compatible(image, arch)) throw new Error('请选择与当前架构兼容的 WorkStep Home 运行时镜像')
  const directory = path.join(root, 'desktop')
  await fs.mkdir(directory, { recursive: true })
  const temporary = await fs.mkdtemp(path.join(directory, 'docker-image-'))
  try {
    const archive = path.join(temporary, 'image.tar')
    await execute(docker, ['save', '--output', archive, id])
    // Docker's containerd store exposes a manifest ID; Podman uses the
    // config digest. Derive that identity from the exported bytes.
    const manifests = JSON.parse(await execute('tar', ['-xOf', archive, 'manifest.json']))
    if (manifests.length !== 1) throw new Error('请选择单一架构的本地镜像')
    const config = manifests[0].Config
    if (typeof config !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(config) || config.startsWith('/') || config.split('/').includes('..')) throw new Error('Docker 镜像清单路径无效')
    await execute('tar', ['-xf', archive, '-C', temporary, config])
    const importedId = 'sha256:' + createHash('sha256').update(await fs.readFile(path.join(temporary, config))).digest('hex')
    await command(['load', '--input', archive])
    const imported = await command(['image', 'inspect', '--format={{.Id}}', importedId])
    if (imported.trim().replace(/^sha256:/, '') !== importedId.slice(7)) throw new Error('导入后的镜像 ID 校验失败')
    return importedId
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
}
module.exports = { listDockerImages, importDockerImage }
