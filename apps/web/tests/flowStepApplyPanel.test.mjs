import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panelSource = await readFile(
  new URL('../src/components/FlowStepApplyPanel.tsx', import.meta.url),
  'utf8',
)
const indexCss = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('step choices stay hidden until the user clicks apply', () => {
  assert.match(panelSource, /setActiveCardId\(card\.id\)/)
  assert.match(panelSource, /<ConfirmDialog/)
  assert.match(panelSource, /activeCard\?\.stepChanges/)
  assert.ok(
    panelSource.indexOf('setActiveCardId(card.id)') < panelSource.indexOf('<ConfirmDialog'),
    'compact apply button is rendered before the step selection dialog',
  )
})

test('one changed step applies directly while multiple steps open the picker', () => {
  assert.match(panelSource, /if \(changes\.length === 1\) \{\s*applyCard\(card\)/s)
  assert.match(panelSource, /setActiveCardId\(card\.id\)/)
  assert.match(panelSource, /changes\.length === 1[\s\S]*CHANGE_LABEL\[changes\[0\]\.change\][\s\S]*changes\[0\]\.title/)
})

test('step selector uses a compact checkbox instead of global full-width input styles', () => {
  assert.match(panelSource, /className="flow-step-apply-checkbox"/)
  assert.match(indexCss, /\.flow-step-apply-checkbox\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/s)
})
