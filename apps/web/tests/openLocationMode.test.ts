import assert from 'node:assert/strict'
import test from 'node:test'

import { usesWebDirectoryBrowser } from '../src/utils/openLocation.ts'

test('remote projects always use the web directory browser', () => {
  assert.equal(usesWebDirectoryBrowser('remote', '127.0.0.1', 'Electron/43'), true)
})

test('local projects keep native openers on loopback and Electron', () => {
  assert.equal(usesWebDirectoryBrowser('local', 'localhost', 'Chrome'), false)
  assert.equal(usesWebDirectoryBrowser('local', 'workstep.example.com', 'Electron/43', true), false)
})

test('local projects use the web browser when accessed from a non-local web origin', () => {
  assert.equal(usesWebDirectoryBrowser('local', '192.168.1.20', 'Chrome'), true)
  assert.equal(usesWebDirectoryBrowser('local', 'workstep.example.com', 'Chrome'), true)
})

test('Electron without its directory bridge opens the browser rather than container applications', () => {
 assert.equal(usesWebDirectoryBrowser('local', '127.0.0.1', 'Electron/43', false), true)
})
