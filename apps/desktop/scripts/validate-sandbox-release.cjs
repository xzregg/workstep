const fs = require('node:fs/promises')
const path = require('node:path')
const { validateImage } = require('./write-sandbox-release.cjs')

function validateRelease(release) {
  if (release?.image === null && release.localDocker === true) return
  if (!release?.image) throw new Error('缺少沙箱镜像发布清单；请先设置 SANDBOX_IMAGE 并运行 node scripts/write-sandbox-release.cjs，再打包桌面端')
  validateImage(release.image)
}

module.exports = async function beforePack(context) {
  const file = path.join(context.packager.projectDir, 'src/sandbox-release.json')
  validateRelease(JSON.parse(await fs.readFile(file, 'utf8')))
}
module.exports.validateRelease = validateRelease
