const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { readManagedConfig, rootFingerprint } = require('../src/managed-config.cjs')
const { createPublicKey } = require('node:crypto')
const desktopPackage = require('../package.json')

function managedBuildConfig(bundleDir) {
  if (path.basename(bundleDir) !== 'managed-gateway') throw new Error('Bundle directory must be named managed-gateway')
  const rootPin = rootFingerprint(createPublicKey(fs.readFileSync(path.join(bundleDir, 'managed-root.pem'))))
  readManagedConfig(path.dirname(bundleDir), rootPin)
  return {
    ...desktopPackage.build,
    extraMetadata: { ...desktopPackage.build.extraMetadata, managedGatewayRootFingerprint: rootPin },
    extraResources: [
      ...desktopPackage.build.extraResources.map((resource) => ({
        ...resource, from: path.resolve(__dirname, '..', resource.from),
      })),
      { from: bundleDir, to: 'managed-gateway' },
    ],
  }
}

if (require.main === module) {
  const bundleDir = process.env.WORKSTEP_MANAGED_BUNDLE_DIR
  if (!bundleDir) throw new Error('WORKSTEP_MANAGED_BUNDLE_DIR is required')
  const config = managedBuildConfig(path.resolve(bundleDir))
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-managed-build-'))
  try {
    const configPath = path.join(tempDir, 'electron-builder.json')
    fs.writeFileSync(configPath, JSON.stringify(config))
    const result = spawnSync(path.join(__dirname, '..', 'node_modules', '.bin', 'electron-builder'),
      ['--config', configPath, '--publish', 'never', ...process.argv.slice(2)], { stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

module.exports = { managedBuildConfig }
