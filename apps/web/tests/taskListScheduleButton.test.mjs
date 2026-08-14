import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')

test('hides the zero schedule count while keeping the schedule button', () => {
  assert.match(source, /scheduleCount > 0 && `\(\$\{scheduleCount\}\)`/)
})

test('shows remote project sharing before schedules for local projects', () => {
  const shareButton = source.indexOf("t('layout.remoteShareTitle')")
  const scheduleButton = source.indexOf("t('schedules.openTitle')")
  assert.ok(shareButton >= 0, 'task board should expose remote project sharing')
  assert.ok(scheduleButton >= 0, 'task board should keep the schedules button')
  assert.ok(shareButton < scheduleButton, 'sharing should appear to the left of schedules')
  assert.match(source, /activeProject\.type !== 'remote'/)
  assert.match(source, /<ProjectShareDialog\s+project=/)
})
