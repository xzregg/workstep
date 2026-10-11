const test = require('node:test')
const assert = require('node:assert/strict')
const { validateReleaseImage, validateContainer, validateWslRegistration, redact } = require('../../../scripts/windows-sandbox-acceptance.cjs')

test('sandbox acceptance requires a pinned release image, not a mutable tag', () => {
  const image = `ghcr.io/xzregg/workstep@sha256:${'a'.repeat(64)}`
  assert.equal(validateReleaseImage({ image }), image)
  for (const value of [{ image: 'ghcr.io/xzregg/workstep:latest' }, { localDocker: true }, null]) {
    assert.throws(() => validateReleaseImage(value))
  }
})

test('sandbox acceptance verifies Linux amd64, immutable image and isolated mounts', () => {
  const details = { Image: 'a'.repeat(64), Config: { Image: `ghcr.io/xzregg/workstep@sha256:${'b'.repeat(64)}` },
    HostConfig: { Privileged: false }, Mounts: [{ Destination: '/root' }, { Destination: '/data/projects' }] }
  const image = { Id: 'a'.repeat(64), Os: 'linux', Architecture: 'amd64' }
  validateContainer(details, image, details.Config.Image)
  for (const bad of [{ ...image, Os: 'windows' }, { ...image, Architecture: 'arm64' }, { ...image, Id: 'c'.repeat(64) }]) {
    assert.throws(() => validateContainer(details, bad, details.Config.Image))
  }
  assert.throws(() => validateContainer({ ...details, HostConfig: { Privileged: true } }, image, details.Config.Image))
  assert.throws(() => validateContainer({ ...details, Mounts: [...details.Mounts, { Destination: '/run/podman/podman.sock' }] }, image, details.Config.Image))
})

test('sandbox acceptance requires WSL2 and an owned disk directory', () => {
  validateWslRegistration([{ DistributionName: 'podman-workstep-test', Version: 2, BasePath: 'C:\\test\\sandbox\\disk' }],
    'workstep-test', 'C:\\test\\sandbox')
  for (const entry of [[], [{ DistributionName: 'other', Version: 2, BasePath: 'C:\\test\\sandbox\\disk' }],
    [{ DistributionName: 'workstep-test', Version: 1, BasePath: 'C:\\test\\sandbox\\disk' }],
    [{ DistributionName: 'workstep-test', Version: 2, BasePath: 'C:\\test\\sandbox-other\\disk' }]]) {
    assert.throws(() => validateWslRegistration(entry, 'workstep-test', 'C:\\test\\sandbox'))
  }
})

test('diagnostic evidence never contains the ephemeral desktop token', () => {
  assert.equal(redact('Error secret123: secret123', 'secret123'), 'Error [redacted]: [redacted]')
})
