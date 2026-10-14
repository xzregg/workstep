import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import { statisticsApi } from '../src/api/statistics'
import type { SystemStatisticsReport } from '../src/api/systemStatistics'
import SystemStatisticsPanel from '../src/components/SystemStatisticsPanel'
import StatisticsPage from '../src/pages/StatisticsPage'

const process = { pid: 42, name: 'python', cpu_percent: 1.2, memory_rss: 186 * 1024 ** 2, threads: 12, descriptors: 128, uptime_seconds: 194400 }
const report: SystemStatisticsReport = {
  status: 'ok', interval_seconds: 5, retention_seconds: 1800, sample_age_seconds: 0, collection_duration_ms: 3.2,
  sample: {
    sampled_at: new Date().toISOString(), platform: 'Darwin', descriptor_kind: 'fds', partial: false,
    host: { cpu_count: 12, cpu_percent: 24.8, memory_used: 19.6 * 1024 ** 3, memory_total: 32 * 1024 ** 3, memory_available: 12.4 * 1024 ** 3, memory_percent: 61.3, swap_total: 4 * 1024 ** 3, swap_used: .8 * 1024 ** 3, disk_total: 1000 * 1024 ** 3, disk_used: 477 * 1024 ** 3, disk_free: 523 * 1024 ** 3, disk_percent: 47.7, network_recv_per_second: 1.24 * 1024 ** 2, network_sent_per_second: 186 * 1024 },
    daemon: { ...process, descriptor_limit: 4096 }, children: [{ ...process, pid: 43, name: 'codex' }],
    total: { cpu_percent: 2.4, memory_rss: 372 * 1024 ** 2, threads: 24, descriptors: 256 },
    children_summary: { process_count: 1, cpu_percent: 1.2, memory_rss: 186 * 1024 ** 2, threads: 12, descriptors: 128 },
  },
  history: [0, 5, 10].map(seconds => ({ sampled_at: new Date(Date.now() - seconds * 1000).toISOString(), host_cpu_percent: 24.8, host_memory_used: 19.6 * 1024 ** 3, total_cpu_percent: 2.4, total_memory_rss: 372 * 1024 ** 2, total_descriptors: 256, daemon_descriptors: 128 })).reverse(),
}

async function mount(component: React.ReactNode, url = 'http://localhost/statistics', setup?: (window: Window) => void) {
  const window = new Window({ url })
  Object.assign(globalThis, { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  setup?.(window)
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () => root.render(<I18nProvider>{component}</I18nProvider>))
  return { window, container, async close() { await act(async () => root.unmount()); await window.happyDOM.close() } }
}
function button(container: HTMLElement, text: string) {
  const result = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
  assert.ok(result, text)
  return result
}

test('system panel matches prototype structure and switches trends, pauses, and warns on descriptors', async () => {
  const original = statisticsApi.system
  let current = report, calls = 0
  statisticsApi.system = async () => { calls++; return current }
  const view = await mount(<SystemStatisticsPanel />)
  try {
    const text = view.container.textContent || ''
    for (const label of ['整机资源', 'WorkStep 运行', '资源趋势', '后台状态', '子进程明细', 'codex', '128 / 4,096']) assert.ok(text.includes(label), label)
    assert.equal(view.container.querySelectorAll('.system-host-card').length, 4)
    assert.equal(view.container.querySelectorAll('.system-strip-item').length, 5)
    await act(async () => button(view.container, '内存').click())
    assert.match(view.container.querySelector('svg[role=img]')?.getAttribute('aria-label') || '', /内存/)
    await act(async () => button(view.container, '暂停刷新').click())
    assert.match(view.container.textContent || '', /已暂停刷新/)
    const before = calls
    await act(async () => document.dispatchEvent(new view.window.Event('visibilitychange')))
    assert.equal(calls, before)
    current = structuredClone(report)
    current.sample!.daemon.descriptors = 3400
    await act(async () => button(view.container, '刷新').click())
    assert.match(view.container.textContent || '', /83.0%/)
    assert.match(view.container.textContent || '', /3,400 \/ 4,096/)
  } finally { await view.close(); statisticsApi.system = original }
})

test('failed refresh preserves last sample and retries; unsupported Windows metrics do not become zero', async () => {
  const original = statisticsApi.system
  let fail = false
  const windows = structuredClone(report)
  windows.sample!.platform = 'Windows'; windows.sample!.descriptor_kind = 'handles'
  windows.sample!.daemon.descriptor_limit = null
  windows.sample!.host.network_recv_per_second = null
  windows.sample!.partial = true
  statisticsApi.system = async () => { if (fail) throw Error('offline'); return windows }
  const view = await mount(<SystemStatisticsPanel />)
  try {
    assert.match(view.container.textContent || '', /句柄/)
    assert.match(view.container.textContent || '', /不可用/)
    assert.match(view.container.textContent || '', /不完整/)
    fail = true
    await act(async () => button(view.container, '刷新').click())
    assert.match(view.container.textContent || '', /保留最后一次成功数据/)
    assert.match(view.container.textContent || '', /codex/)
    fail = false
    await act(async () => button(view.container, '重试').click())
    assert.doesNotMatch(view.container.textContent || '', /保留最后一次成功数据/)
  } finally { await view.close(); statisticsApi.system = original }
})

test('warming sample renders collecting state instead of false zeros', async () => {
  const original = statisticsApi.system
  statisticsApi.system = async () => ({ ...report, status: 'warming', sample: null, history: [] })
  const view = await mount(<SystemStatisticsPanel />)
  try { assert.match(view.container.textContent || '', /采样中/); assert.equal(view.container.querySelector('table'), null) }
  finally { await view.close(); statisticsApi.system = original }
})

test('page mounts only active statistics tab and hides host metrics in remote browsers', async () => {
  const originalSystem = statisticsApi.system, originalOverview = statisticsApi.overview
  let systemCalls = 0, businessCalls = 0
  statisticsApi.system = async () => { systemCalls++; return report }
  statisticsApi.overview = async () => { businessCalls++; throw Error('business fixture') }
  const view = await mount(<MemoryRouter initialEntries={['/statistics?tab=system&range=7d']}><StatisticsPage /></MemoryRouter>)
  try {
    assert.equal(systemCalls, 1); assert.equal(businessCalls, 0)
    await act(async () => button(view.container, '业务统计').click())
    assert.equal(businessCalls, 1)
    assert.equal(view.container.querySelector('.system-statistics'), null)
    await act(async () => button(view.container, '系统运行').click())
    assert.equal(systemCalls, 2)
  } finally { await view.close() }
  const remote = await mount(<MemoryRouter initialEntries={['/statistics?tab=system']}><StatisticsPage /></MemoryRouter>, 'https://d-device.gateway.example/statistics')
  try { assert.equal([...remote.container.querySelectorAll('[role=tab]')].some(b => b.textContent==='系统运行'), false); assert.equal(systemCalls, 2) }
  finally { await remote.close(); statisticsApi.system = originalSystem; statisticsApi.overview = originalOverview }
})

test('polling stops when hidden, never overlaps requests, and cannot restart after unmount', async () => {
  const original = statisticsApi.system
  let calls = 0, nextTimer = 1
  const timers = new Map<number, () => Promise<void>>()
  const pending: Array<(value: SystemStatisticsReport) => void> = []
  statisticsApi.system = () => { calls++; return new Promise(resolve => pending.push(resolve)) }
  const view = await mount(<SystemStatisticsPanel />, 'http://localhost/', window => {
    window.setTimeout = ((callback: () => Promise<void>) => { const id = nextTimer++; timers.set(id, callback); return id }) as typeof window.setTimeout
    window.clearTimeout = (id: number | undefined) => { if (id !== undefined) timers.delete(id) }
    Object.defineProperty(window.document, 'visibilityState', { configurable: true, writable: true, value: 'visible' })
  })
  let closed = false
  try {
    assert.equal(calls, 1)
    await act(async () => document.dispatchEvent(new view.window.Event('visibilitychange')))
    assert.equal(calls, 1, 'visibility does not duplicate an in-flight load')
    await act(async () => pending.shift()!(report))
    Object.defineProperty(document, 'visibilityState', { value: 'hidden' })
    await act(async () => document.dispatchEvent(new view.window.Event('visibilitychange')))
    assert.equal(timers.size, 0)
    assert.equal(calls, 1)
    Object.defineProperty(document, 'visibilityState', { value: 'visible' })
    await act(async () => document.dispatchEvent(new view.window.Event('visibilitychange')))
    assert.equal(calls, 2)
    await act(async () => pending.shift()!(report))
    await act(async () => button(view.container, '暂停刷新').click())
    assert.equal(timers.size, 0)
    await act(async () => button(view.container, '继续刷新').click())
    const [id, callback] = [...timers.entries()][0]
    timers.delete(id)
    let running: Promise<void> | undefined
    await act(async () => { running = callback() })
    assert.equal(calls, 3)
    await view.close(); closed = true
    pending.shift()!(report)
    await running
    assert.equal(timers.size, 0, 'a pending timer callback cannot reschedule after unmount')
  } finally { if (!closed) await view.close(); statisticsApi.system = original }
})

test('unknown and failed trend samples create gaps, not false zero values or connecting lines', async () => {
  const original = statisticsApi.system
  const missing = structuredClone(report)
  missing.history = Array.from({ length: 5 }, (_, i) => ({ ...report.history[0], sampled_at: new Date(Date.now() - (4 - i) * 5000).toISOString(), host_cpu_percent: i === 2 ? null : 24.8, total_cpu_percent: i === 2 ? null : 2.4 }))
  statisticsApi.system = async () => missing
  const view = await mount(<SystemStatisticsPanel />)
  try {
    assert.equal(view.container.querySelectorAll('.system-chart-line').length, 4)
    await act(async () => view.container.querySelector<SVGElement>('.system-chart')!.dispatchEvent(new view.window.FocusEvent('focusin', { bubbles: true })))
    const chart = view.container.querySelector<SVGElement>('.system-chart')!
    await act(async () => chart.dispatchEvent(new view.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    await act(async () => chart.dispatchEvent(new view.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    assert.match(view.container.querySelector('.system-chart-tooltip')?.textContent || '', /不可用/)
  } finally { await view.close(); statisticsApi.system = original }
})
