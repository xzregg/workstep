import assert from 'node:assert/strict'
import test from 'node:test'

import {
  requiresEngineHandoff,
  resolveForkContextMode,
} from '../src/utils/chatSessionFork.ts'


test('same engine defaults to native fork only when capability is real', () => {
  assert.equal(resolveForkContextMode('codex_sdk', 'codex_sdk', true), 'native')
  assert.equal(resolveForkContextMode('codex', 'codex', false), 'smart')
})


test('switching engines always defaults to explicit smart handoff', () => {
  assert.equal(resolveForkContextMode('claude', 'codex_sdk', true), 'smart')
})


test('forking an earlier message uses explicit handoff even on a native engine', () => {
  assert.equal(resolveForkContextMode('codex_sdk', 'codex_sdk', true, false), 'smart')
})


test('selecting another engine requests handoff only when history exists', () => {
  assert.equal(requiresEngineHandoff('claude', 'codex_sdk', 6), true)
  assert.equal(requiresEngineHandoff('claude', 'claude', 6), false)
  assert.equal(requiresEngineHandoff('claude', 'codex_sdk', 0), false)
})
