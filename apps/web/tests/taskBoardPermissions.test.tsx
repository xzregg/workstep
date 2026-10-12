import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import TaskBoardCard from '../src/components/TaskBoardCard'
import { I18nProvider } from '../src/i18n'
import type { Task } from '../src/api/client'
const task = { id: 'task', title: 'Task', status: 'ready', steps: [{ step_key: 'do', status: 'pending', started_at: null }], created_at: '2026-01-01', engine: 'codex', cwd: '/demo', description: '', updated_at: '2026-01-01' } as Task
const noop = () => {}
const card = (overrides: object = {}) => renderToStaticMarkup(<I18nProvider><TaskBoardCard task={task} durationNowMs={0} showArchived={false} starting={false}
  onOpen={noop} onStart={noop} onArchive={noop} onRestore={noop} onDelete={noop} onDragStart={noop} onDragEnd={noop} {...overrides} /></I18nProvider>)
test('every non-running active task can be archived when archive is allowed', () => {
 assert.match(card(), /data-task-action="archive"/)
 assert.doesNotMatch(card({ task: { ...task, status: 'running' } }), /data-task-action="archive"/)
 assert.doesNotMatch(card({ showArchived: true }), /data-task-action="archive"/)
})
test('task actions have independent permissions and readonly cards preserve viewing', () => {
 const html = card({ readOnly: true, canRun: false, canArchive: false, canDelete: false })
 assert.match(html, /Task/)
 assert.doesNotMatch(html, /data-task-action="(?:start|archive|delete)"/)
 const run = card({ readOnly: true, canRun: true, canArchive: false, canDelete: false })
 assert.match(run, /data-task-action="start"/)
 assert.doesNotMatch(run, /data-task-action="(?:archive|delete)"/)
})
