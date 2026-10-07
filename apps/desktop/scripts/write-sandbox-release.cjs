const fs = require('node:fs')
const path = require('node:path')
function validateImage(image) {
  if (!/^ghcr\.io\/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$/.test(image || '')) throw new Error('SANDBOX_IMAGE must be an immutable GHCR image digest')
  return image
}
if (require.main === module) {
  const image = validateImage(process.env.SANDBOX_IMAGE)
  fs.writeFileSync(path.join(__dirname, '../src/sandbox-release.json'), JSON.stringify({ image }) + '\n')
}
module.exports = { validateImage }
