import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')

test('remote projects use a text badge instead of a status dot', () => {
  assert.match(source, /t\('layout\.remoteLabel'\)/)
  assert.match(source, /color: 'var\(--meta\)'/)
  assert.doesNotMatch(source, /p\.connection_status === 'connected' \? '●' : '○'/)
})
