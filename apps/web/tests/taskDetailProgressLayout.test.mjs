import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/pages/TaskDetail.tsx', import.meta.url), 'utf8')

test('shows the status badge right of the stage icon', () => {
  const iconPos = source.indexOf('{/* Dot */}')
  const statusPos = source.indexOf("left: 'calc(50% + 14px)'")
  const namePos = source.indexOf("height: 28, marginTop: 8")
  assert.ok(iconPos >= 0, 'icon row missing')
  assert.ok(statusPos > iconPos, 'status badge beside icon missing')
  assert.ok(namePos > statusPos, 'name slot after status missing')
  const statusBlock = source.slice(statusPos, namePos)
  assert.match(statusBlock, /STAGE_STATE_LABEL_KEYS\[visualState\]/)
  const roundPos = source.indexOf("height: 20, marginTop: 2")
  const nameRow = source.slice(namePos, roundPos)
  assert.match(nameRow, /stage\.label/)
  assert.doesNotMatch(nameRow, /STAGE_STATE_LABEL_KEYS/)
})

test('keeps name, round and time rows in fixed slots', () => {
  assert.match(source, /height: 28, marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'center'/)
  assert.match(source, /height: 20, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center'/)
  assert.match(source, /minHeight: 32, marginTop: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2/)
})
