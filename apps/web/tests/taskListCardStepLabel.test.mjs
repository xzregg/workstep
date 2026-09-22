import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')

test('does not show the lane step name inside task cards', () => {
  assert.doesNotMatch(
    source,
    /background: `color-mix\(in oklab, \$\{lane\.color\}, transparent 90%\)`/,
  )
})

test('limits task card descriptions to a short preview', () => {
  assert.match(source, /WebkitLineClamp: 2/)
  assert.match(source, /WebkitBoxOrient: 'vertical'/)
  assert.match(source, /overflow: 'hidden'/)
})

test('shows the scheduled time to the left of the task status', () => {
  const scheduledTimePos = source.indexOf("task.scheduled_start_state === 'pending'")
  const taskStatusPos = source.indexOf('data-s={displayStatus}')

  assert.ok(scheduledTimePos >= 0, 'scheduled time is missing from task cards')
  assert.ok(taskStatusPos > scheduledTimePos, 'scheduled time should precede the task status')
})

test('shows a clock icon before the scheduled time on task cards', () => {
  assert.match(
    source,
    /task\.scheduled_start_state === 'pending'[\s\S]*?<Icon name="clock" size=\{11\} strokeWidth=\{2\} \/>[\s\S]*?formatScheduledStart\(task\.scheduled_start_at\)/,
  )
})
