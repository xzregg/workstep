import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/components/Layout.css', import.meta.url), 'utf8')

test('remote projects use a text badge instead of a status dot', () => {
  assert.match(source, /t\('layout\.remoteLabel'\)/)
  assert.match(source, /className="layout-project-remote-badge"/)
  assert.match(css, /\.layout-project-remote-badge\s*\{[^}]*color: var\(--meta\)/)
  assert.doesNotMatch(source, /p\.connection_status === 'connected' \? '●' : '○'/)
})

test('project rows show a running spinner when any workflow is running', () => {
  assert.match(source, /p\.workflows\?\.some\(\(workflow\) => workflow\.running\)/)
  assert.match(source, /runningTitle=.*t\('layout\.flowRunning'\)/)
})

test('remote projects refresh from websocket status events instead of polling the project list', () => {
  assert.doesNotMatch(source, /window\.setInterval\(\(\) => \{ void fetchProjects\(\) \}, 3000\)/)
})
