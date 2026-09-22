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


test('selecting another provider on the same engine requests handoff', () => {
  assert.equal(requiresEngineHandoff('claude', 'claude', 6, 'provider-a', 'provider-b'), true)
  assert.equal(requiresEngineHandoff('claude', 'claude', 6, '', 'provider-b'), true)
  assert.equal(requiresEngineHandoff('claude', 'claude', 6, 'provider-a', 'provider-a'), false)
  assert.equal(requiresEngineHandoff('claude', 'claude', 0, 'provider-a', 'provider-b'), false)
})


test('retargeting a pending handoff does not request the handoff choice again', () => {
  assert.equal(
    requiresEngineHandoff('codex_sdk', 'codex_sdk', 6, '', 'provider-b', true),
    false,
  )
})
