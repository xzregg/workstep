import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const plist = file => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(root, file)], { encoding: 'utf8' }))
test('Xcode app target includes every Swift source and required resources', () => {
  const project = plist('WorkStep.xcodeproj/project.pbxproj')
  const objects = project.objects
  const target = Object.values(objects).find(o => o.isa === 'PBXNativeTarget' && o.name === 'WorkStep')
  const files = target.buildPhases.flatMap(id => objects[id].files).map(id => objects[objects[id].fileRef].path)
  for (const file of readdirSync(path.join(root, 'WorkStep'), { recursive: true }).filter(file => file.endsWith('.swift'))) {
    assert.ok(files.includes('WorkStep/' + file), `missing source ${file}`)
  }
  assert.ok(files.includes('WorkStep/Resources/bridge.js'))
  assert.ok(files.includes('WorkStep/Resources/Assets.xcassets'))
  for (const file of files) assert.ok(existsSync(path.join(root, file)), file)
  const info = plist('WorkStep/Info.plist')
  assert.ok(info.NSMicrophoneUsageDescription)
  assert.ok(info.NSLocalNetworkUsageDescription)
  assert.equal(info.UIBackgroundModes, undefined, 'must not claim unsupported background execution')
})
test('app icon is 1024 pixels and opaque', () => {
  const file = path.join(root, 'WorkStep/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png')
  const bytes = readFileSync(file)
  assert.equal(bytes.readUInt32BE(16), 1024)
  assert.equal(bytes.readUInt32BE(20), 1024)
  assert.equal(bytes[25], 2, 'PNG must be RGB without alpha')
})
