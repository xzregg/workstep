import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import ProjectAuditSettings from '../src/components/ProjectAuditSettings'
import { projectAuditApi, type ProjectAuditPage } from '../src/api/projectAudit'

test('audit renders escaped identities, filters, pagination and retry with one request per change', async () => {
  const { document, window } = installDomEnvironment()
  const original = projectAuditApi.list
  const calls: Array<{ id: string; filters: any }> = []
  let fail = false
  const page: ProjectAuditPage = { items: [{ id: 'event', action: 'file.upload', result: 'succeeded', task_id: null,
    actor_id: 'alice', actor_username: 'alice', actor_name: '<img src=x>', created_at: '2026-10-14T12:00:00Z',
    metadata: { file_name: 'report.txt', access_source: 'gateway' } }], next_before: 'event', retention_days: 30 }
  projectAuditApi.list = async (id, filters) => { calls.push({ id, filters }); if (fail) throw Error('offline'); return page }
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
  const click = async (text: string) => { const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === text)!; assert.ok(button); await act(async () => button.click()); await flush() }
  try {
    await act(async () => root.render(<I18nProvider><ProjectAuditSettings projectId="p1" /></I18nProvider>)); await flush()
    assert.equal(calls.length, 1); assert.ok(host.textContent?.includes('report.txt'))
    assert.ok(host.textContent?.includes('<img src=x>')); assert.equal(host.querySelector('img'), null)
    await click('较早记录'); assert.equal(calls.length, 2); assert.equal(calls[1].filters.before, 'event')
    const select = host.querySelector('select')!
    await act(async () => { select.value = 'file.upload'; select.dispatchEvent(new window.Event('change', { bubbles: true })) }); await flush()
    assert.equal(calls.length, 3); assert.equal(calls[2].filters.action, 'file.upload'); assert.equal(calls[2].filters.before, undefined)
    fail = true; await click('刷新'); assert.ok(host.querySelector('[role="alert"]'))
    fail = false; await click('重试'); assert.equal(host.querySelector('[role="alert"]'), null)
  } finally { await act(async () => root.unmount()); projectAuditApi.list = original }
})

test('switching project aborts the old audit request and ignores its stale response', async () => {
  const { document } = installDomEnvironment()
  const original = projectAuditApi.list
  const pending: Array<{ signal?: AbortSignal; resolve: (page: ProjectAuditPage) => void }> = []
  projectAuditApi.list = (_id, filters) => new Promise(resolve => pending.push({ signal: filters?.signal, resolve }))
  const host = document.createElement('div'); const root = createRoot(host)
  try {
    await act(async () => root.render(<I18nProvider><ProjectAuditSettings key="p1" projectId="p1" /></I18nProvider>))
    await act(async () => root.render(<I18nProvider><ProjectAuditSettings key="p2" projectId="p2" /></I18nProvider>))
    assert.equal(pending.length, 2); assert.equal(pending[0].signal?.aborted, true)
    await act(async () => { pending[1].resolve({ items: [], next_before: null, retention_days: 30 }); await Promise.resolve() })
    assert.ok(host.textContent?.includes('暂无远程操作记录'))
    await act(async () => { pending[0].resolve({ items: [], next_before: 'old', retention_days: 99 }); await Promise.resolve() })
    assert.ok(host.textContent?.includes('30 天')); assert.ok(!host.textContent?.includes('99 天'))
  } finally { await act(async () => root.unmount()); projectAuditApi.list = original }
})
