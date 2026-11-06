const fs = require('node:fs/promises')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { validateImage } = require('./write-sandbox-release.cjs')

function validateRelease(release) {
  if (release?.image === null && release.localDocker === true) return
  if (!release?.image) throw new Error('缺少沙箱镜像发布清单；请先设置 SANDBOX_IMAGE 并运行 node scripts/write-sandbox-release.cjs，再打包桌面端')
  validateImage(release.image)
}

module.exports = async function beforePack(context) {
  const file = path.join(context.packager.projectDir, 'src/sandbox-release.json')
  validateRelease(JSON.parse(await fs.readFile(file, 'utf8')))
  const root = context.packager.projectDir
  const backend = path.join(root, 'resources-placeholder/backend')
  const python = process.platform === 'win32'
    ? path.join(backend, 'python/python.exe') : path.join(backend, 'python/bin/python3.12')
  // Check the actual injected files, not only the repository or build inputs.
  execFileSync(python, [path.resolve(root, '../../scripts/package_payload.py'), 'check',
    path.join(root, 'src'), path.join(backend, 'app/daemon'), path.join(backend, 'web_dist')], { stdio: 'inherit' })
}
module.exports.validateRelease = validateRelease
