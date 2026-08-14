import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/TaskDetailView.tsx', import.meta.url), 'utf8')

test('shows the status badge above the stage name', () => {
  const iconPos = source.indexOf('{/* Dot */}')
  const statusPos = source.indexOf("visualState !== 'pending'")
  const namePos = source.indexOf('height: 28', statusPos)
  assert.ok(iconPos >= 0, 'icon row missing')
  assert.ok(statusPos > iconPos, 'status badge above the name missing')
  assert.ok(namePos > statusPos, 'name slot after status missing')
  const statusBlock = source.slice(statusPos, namePos)
  assert.match(statusBlock, /STAGE_STATE_LABEL_KEYS\[visualState\]/)
  const roundPos = source.indexOf('height: 20', namePos)
  const nameRow = source.slice(namePos, roundPos)
  assert.match(nameRow, /stage\.label/)
  assert.doesNotMatch(nameRow, /STAGE_STATE_LABEL_KEYS/)
})

test('keeps name, round and time rows in fixed slots', () => {
  assert.match(source, /height: 28,\s+marginTop: 8,\s+display: 'flex',\s+alignItems: 'center',\s+justifyContent: 'center'/)
  assert.match(source, /height: 20,\s+marginTop: 2,\s+display: 'flex',\s+alignItems: 'center',\s+justifyContent: 'center'/)
  assert.match(source, /minHeight: 32,\s+marginTop: 2,\s+display: 'flex',\s+flexDirection: 'column',\s+alignItems: 'center',\s+gap: 2/)
})
