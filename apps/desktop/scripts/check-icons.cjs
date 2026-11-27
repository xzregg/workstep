const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const iconFiles = ['build/app-icon.svg', 'build/icon.ico', 'build/icon.icns',
  ...[16, 32, 48, 64, 128, 256, 512, 1024].map(size => `build/icons/${size}x${size}.png`)]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function iconManifest(desktop = path.resolve(__dirname, '..')) {
  return {
    source: sha256(fs.readFileSync(path.resolve(desktop, '../web/public/favicon.svg'))),
    files: Object.fromEntries(iconFiles.map(file => [file, sha256(fs.readFileSync(path.join(desktop, file)))])),
  }
}

function validateIcons(desktop = path.resolve(__dirname, '..')) {
  const expected = JSON.parse(fs.readFileSync(path.join(desktop, 'build/icon-manifest.json'), 'utf8'))
  const actual = iconManifest(desktop)
  if (actual.source !== expected.source) throw new Error('Stale desktop icons: website source changed; run yarn icons')
  for (const file of iconFiles) {
    if (actual.files[file] !== expected.files[file]) throw new Error(`Stale desktop icon ${file}; run yarn icons`)
  }
}

module.exports = { iconFiles, iconManifest, validateIcons }
if (require.main === module) {
  validateIcons()
  console.log('Desktop icon variants match website source and manifest')
}
