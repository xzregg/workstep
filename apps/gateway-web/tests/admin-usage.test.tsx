import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminUsagePage } from '../src/AdminUsagePage'
import { UsageMetricStrip } from '../src/UsageMetricStrip'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/admin/usage',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event, getComputedStyle: dom.window.getComputedStyle,
  SVGElement: dom.window.SVGElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot })
dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false }, media: '', onchange: null })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
const { cleanup, fireEvent, render, screen, waitFor, configure } = await import('@testing-library/react')
configure({ asyncUtilTimeout: 5000 })
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('comparison table formats all time boundaries as readable UTC dates', async () => {
  const totals = { event_count: 0, unmetered_count: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0,
    estimated_cost: null, billed_cost: null, currency: null }
  globalThis.fetch = async () => Response.json(totals)
  const filters = new URLSearchParams({ from_time: '2026-09-21T14:41:54.785+08:00',
    to_time: '2026-10-21T06:41:54.785Z' }).toString()
  const view = render(<UsageMetricStrip summary={totals} filters={filters} overview />)
  await waitFor(() => assert.ok(!screen.queryByRole('status')))
  const rows = Array.from(view.container.querySelectorAll('tbody tr'))
  const boundaries = rows.map(row => Array.from(row.querySelectorAll('td')).slice(1, 3).map(cell => cell.textContent))
  assert.deepEqual(boundaries.slice(0, 3), [
    ['2026-09-21 06:41:54', '2026-10-21 06:41:54'],
    ['2026-08-22 06:41:54', '2026-09-21 06:41:54'],
    ['2025-09-21 06:41:54', '2025-10-21 06:41:54'],
  ])
  for (const value of boundaries[3]) assert.match(value!, /^\d{4}-\d{2}-01 00:00:00$/)
  view.rerender(<UsageMetricStrip summary={totals} filters="" overview />)
  await waitFor(() => assert.ok(!screen.queryByRole('status')))
  assert.equal(screen.getAllByText('不限').length, 2)
  assert.equal(screen.getAllByText('未指定').length, 4)
})

test('usage page filters summaries and locates unmetered and metered events', async () => {
  const urls: string[] = []
  let detailFailures = 1
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    if (url.startsWith('/api/admin/usage/reconciliation?')) return Response.json({ rows: [{
      day: '2026-09-29', provider_id: 'provider-1', model: 'model-a', status: 'different',
      device_event_count: 1, provider_line_count: 1, unmetered_count: 0,
      device_input_tokens: 10, device_output_tokens: 5,
      provider_input_tokens: 12, provider_output_tokens: 5,
      input_tokens_difference: 2, output_tokens_difference: 0,
      estimated_cost: '0.000030', billed_cost: '0.000040',
      cost_difference: '0.000010', currency: 'USD',
    }] })
    if (url.startsWith('/api/admin/usage/events?')) {
      if (detailFailures > 0) { detailFailures--; return new Response(null, { status: 503 }) }
      if (new URLSearchParams(url.split('?')[1]).get('source') === 'provider_reconciled') {
        return Response.json({ total: 1, events: [{
          id: 'bill-1', request_id: 'provider-line-1', source: 'provider_reconciled',
          metering_status: 'metered', occurred_at: '2026-09-29T00:00:00Z',
          user_id: null, initiated_by_user_id: null, device_id: 'provider-bill',
          project_id: null, task_id: null, run_id: null, message_id: null,
          session_id: null, provider_id: 'provider-1', provider_revision: null,
          model: 'model-a', input_tokens: 12, output_tokens: 5,
          cache_read_tokens: null, cache_write_tokens: null, total_tokens: 17,
          pricing_version: null, currency: 'USD', estimated_cost: null,
          billed_cost: '0.000040',
        }] })
      }
      const page = new URLSearchParams(url.split('?')[1]).get('page')
      return Response.json({ total: 26, events: [page === '2' ? {
        id: 'usage-2', request_id: 'request-2', source: 'reported_by_device',
        metering_status: 'metered', occurred_at: '2026-09-29T10:00:00Z',
        user_id: 'user-1', initiated_by_user_id: 'user-1', device_id: 'pc-1', device_name: '研发工作站', user_name: '演示用户', project_name: '演示项目',
        project_id: 'project-1', task_id: 'task-1', run_id: null, message_id: 'message-1',
        session_id: null, provider_id: 'provider-1', provider_revision: 2,
        model: 'model-a', input_tokens: 10, output_tokens: 5, cache_read_tokens: 0,
        cache_write_tokens: 0, total_tokens: 15, pricing_version: 'v1',
        currency: 'USD', estimated_cost: '0.000030',
      } : {
        id: 'usage-1', request_id: null, source: 'reported_by_device',
        metering_status: 'unmetered', occurred_at: '2026-09-29T09:00:00Z',
        user_id: 'user-1', initiated_by_user_id: 'user-1', device_id: 'pc-1',
        project_id: null, task_id: null, run_id: null, message_id: null, session_id: null,
        provider_id: null, provider_revision: null, model: 'model-b',
        input_tokens: null, output_tokens: null, cache_read_tokens: null,
        cache_write_tokens: null, total_tokens: null, pricing_version: null,
        currency: null, estimated_cost: null,
      }] })
    }
    if (url.startsWith('/api/admin/usage?')) return Response.json({
      event_count: 26, unmetered_count: 2, input_tokens: 10, output_tokens: 5,
      cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 15,
      estimated_cost: '0.000030', billed_cost: '0.000040', currency: 'USD', group_total: 1,
      groups: [{ value: 'model-a', event_count: 26, unmetered_count: 2,
        input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0,
        total_tokens: 15, estimated_cost: '0.000030', currency: 'USD' }],
    })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminUsagePage /></MemoryRouter>)
  await screen.findByText(/26 条计量事件 · 2 条未完成计量/)
  fireEvent.click(screen.getByRole('tab', { name: '用量明细' }))
  await screen.findByText(/用量明细加载失败/)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('model-b')
  assert.ok(screen.getByRole('cell', {name:'未关联项目'}))
  assert.ok(screen.getByRole('columnheader', {name:'总 Token'}))
  assert.ok(screen.getByRole('columnheader', {name:'缓存读取'}))
  assert.ok(screen.getByRole('cell', {name:/待计价/}))
  const initialQuery = new URLSearchParams(urls.find(url => url.startsWith('/api/admin/usage?'))!.split('?')[1])
  assert.ok(initialQuery.get('from_time'))
  assert.ok(initialQuery.get('to_time'))
  const duration = Date.parse(initialQuery.get('to_time')!) - Date.parse(initialQuery.get('from_time')!)
  assert.ok(duration >= 28 * 86400000 && duration <= 31 * 86400000)
  fireEvent.change(screen.getByLabelText('计量来源'), { target: { value: 'reported_by_device' } })
  fireEvent.click(screen.getByText('更多筛选（用户、设备、项目、供应商、模型）'))
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'model-a' } })
  fireEvent.click(screen.getByRole('button', { name: '查询用量' }))
  await waitFor(() => assert.ok(urls.some(url => url.includes('source=reported_by_device')
    && url.includes('model=model-a') && url.includes('from_time='))))
  fireEvent.click(screen.getByRole('tab', { name: '模型统计' }))
  await screen.findByText(/共 1 组/)
  fireEvent.click(screen.getByRole('tab', { name: '用量明细' }))
  await screen.findByText('model-b')
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByText('model-a')
  assert.ok(screen.getByRole('cell', {name:'演示项目'}))
  assert.ok(screen.getByRole('cell', {name:'演示用户'}))
  assert.ok(screen.getByRole('cell', {name:'研发工作站'}))
  fireEvent.click(screen.getByRole('button', {name:'查看事件 usage-2'}))
  await screen.findByText('usage-2')
  assert.ok(screen.getByText('request-2'))
  assert.ok(urls.some(url => url.includes('/events?') && url.includes('page=2')))
  fireEvent.click(screen.getByRole('tab', { name: '供应商对账' }))
  fireEvent.change(screen.getByLabelText('对账供应商 ID'), { target: { value: 'provider-1' } })
  fireEvent.click(await screen.findByPlaceholderText('对账开始日期'))
  fireEvent.click(await screen.findByText('最近 7 天'))
  fireEvent.click(screen.getByRole('button', { name: '查看账单差异' }))
  await screen.findByText(/model-a · 差异/)
  assert.match(document.body.textContent ?? '', /账单 0.000040 USD/)
  fireEvent.change(screen.getByLabelText('计量来源'), { target: { value: 'provider_reconciled' } })
  fireEvent.click(screen.getByRole('button', { name: '查询用量' }))
  fireEvent.click(screen.getByRole('tab', { name: '用量明细' }))
  assert.ok((await screen.findAllByText('0.000040 USD')).length >= 1)
  fireEvent.click(screen.getByRole('button', {name:'查看事件 bill-1'}))
  await screen.findByText('provider-1')
})

test('provider bill import requires step-up and submits only bounded billing fields', async () => {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-1' })
    if (url === '/api/auth/step-up') return Response.json({ expires_in_seconds: 300 })
    if (url === '/api/admin/usage/provider-bills') return Response.json({
      accepted: ['line-1'], duplicates: [],
    })
    if (url.startsWith('/api/admin/usage/events?')) return Response.json({ events: [], total: 0 })
    if (url.startsWith('/api/admin/usage?')) return Response.json({
      event_count: 0, unmetered_count: 0, input_tokens: null, output_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null, total_tokens: null,
      estimated_cost: null, billed_cost: null, currency: null,
    })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminUsagePage /></MemoryRouter>)
  fireEvent.click(screen.getByRole('tab', { name: '供应商对账' }))
  fireEvent.click(screen.getByRole('button', { name: '导入供应商账单' }))
  const dialog = await screen.findByRole('dialog', { name: '导入供应商账单' })
  const { getByLabelText, getByRole } = await import('@testing-library/dom')
  fireEvent.change(getByLabelText(dialog, '供应商 ID'), { target: { value: 'provider-1' } })
  fireEvent.change(getByLabelText(dialog, '账单行 ID'), { target: { value: 'line-1' } })
  fireEvent.change(getByLabelText(dialog, '模型'), { target: { value: 'model-a' } })
  fireEvent.change(getByLabelText(dialog, 'UTC 日期'), { target: { value: '2026-09-29' } })
  fireEvent.change(getByLabelText(dialog, '输入 Token'), { target: { value: '12' } })
  fireEvent.change(getByLabelText(dialog, '输出 Token'), { target: { value: '5' } })
  fireEvent.change(getByLabelText(dialog, '账单金额'), { target: { value: '0.000040' } })
  fireEvent.change(getByLabelText(dialog, '管理员密码'), { target: { value: 'secret' } })
  fireEvent.click(getByRole(dialog, 'button', { name: '导入账单行' }))
  await screen.findByText(/已导入 1 条账单行/)
  assert.deepEqual(requests.filter(item => item.url === '/api/admin/usage/provider-bills')[0].body, {
    batch_id: 'line-1', lines: [{ line_id: 'line-1', provider_id: 'provider-1',
      model: 'model-a', day: '2026-09-29', input_tokens: 12, output_tokens: 5,
      currency: 'USD', billed_cost: '0.000040' }],
  })
  assert.ok(requests.findIndex(item => item.url === '/api/auth/step-up') <
    requests.findIndex(item => item.url === '/api/admin/usage/provider-bills'))
})


test('read-only usage page exposes scoped reports without global bill controls', async () => {
  const paths: string[] = []
  globalThis.fetch = async input => {
    const path = String(input); paths.push(path)
    if (path.startsWith('/api/admin/usage/events?')) return Response.json({ events: [], total: 0 })
    if (path.startsWith('/api/admin/usage?')) return Response.json({ event_count: 0, unmetered_count: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, total_tokens: null, estimated_cost: null, billed_cost: null, currency: null, groups: [], group_total: 0 })
    throw new Error(path)
  }
  render(<MemoryRouter><AdminUsagePage readOnly /></MemoryRouter>)
  await screen.findByText('当前条件下没有计量事件。')
  assert.equal(screen.queryByRole('button', { name: '导入供应商账单' }), null)
  assert.equal(screen.queryByLabelText('对账供应商 ID'), null)
  assert.ok(paths.every(path => !path.includes('/reconciliation')))
})

test('reset restores the recent month and clears other filters', async () => {
  const paths: string[] = []
  globalThis.fetch = async input => {
    paths.push(String(input))
    return Response.json({ events: [], total: 0, groups: [], group_total: 0, event_count: 0, unmetered_count: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, total_tokens: null, estimated_cost: null, billed_cost: null, currency: null })
  }
  render(<MemoryRouter><AdminUsagePage readOnly /></MemoryRouter>)
  await screen.findByText('当前条件下没有计量事件。')
  fireEvent.click(screen.getByText('更多筛选（用户、设备、项目、供应商、模型）'))
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'model-a' } })
  fireEvent.click(screen.getByRole('button', { name: '查询用量' }))
  await waitFor(() => assert.ok(paths.some(path => path.includes('model=model-a'))))
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
  await waitFor(() => {
    const query = new URLSearchParams(paths.filter(path => path.startsWith('/api/admin/usage?')).at(-1)!.split('?')[1])
    assert.ok(query.get('from_time') && query.get('to_time'))
    assert.equal(query.get('model'), null)
  })
})

test('calendar shortcut changes the range sent to the usage API', async () => {
  const paths: string[] = []
  globalThis.fetch = async input => {
    paths.push(String(input))
    return Response.json({ events: [], total: 0, groups: [], group_total: 0, event_count: 0, unmetered_count: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, total_tokens: null, estimated_cost: null, billed_cost: null, currency: null })
  }
  render(<MemoryRouter><AdminUsagePage readOnly /></MemoryRouter>)
  fireEvent.click(await screen.findByPlaceholderText('开始时间'))
  fireEvent.click(await screen.findByText('最近 7 天'))
  fireEvent.click(screen.getByRole('button', { name: '查询用量' }))
  await waitFor(() => {
    const query = new URLSearchParams(paths.filter(path => path.startsWith('/api/admin/usage?')).at(-1)!.split('?')[1])
    assert.equal(Date.parse(query.get('to_time')!) - Date.parse(query.get('from_time')!), 7 * 86400000)
  })
})


test('statistics tabs share the applied time filters and load only the active report', async () => {
 const paths:string[]=[]
 globalThis.fetch=async input=>{
  const path=String(input);paths.push(path)
  const params=new URLSearchParams(path.split('?')[1])
  return Response.json({event_count:8,unmetered_count:2,input_tokens:100,output_tokens:20,cache_read_tokens:null,cache_write_tokens:0,total_tokens:120,estimated_cost:null,billed_cost:null,currency:'mixed',group_total:2,groups:[
   {value:params.get('group_by')==='day'?'2026-10-01':'first',event_count:3,unmetered_count:0,input_tokens:100,output_tokens:20,total_tokens:120,cache_read_tokens:null,cache_write_tokens:0,estimated_cost:'1',currency:'USD'},
   {value:params.get('group_by')==='day'?'2026-10-02':'second',event_count:5,unmetered_count:2,input_tokens:null,output_tokens:null,total_tokens:null,cache_read_tokens:null,cache_write_tokens:null,estimated_cost:null,currency:'mixed'},
  ]})
 }
 render(<MemoryRouter><AdminUsagePage readOnly /></MemoryRouter>)
 await screen.findByRole('img',{name:'每日 Token 趋势（UTC）'})
 assert.ok(screen.getByRole('img',{name:'每日调用趋势（UTC）'}))
 const chart=screen.getByRole('img',{name:'每日 Token 趋势（UTC）'})
 assert.equal(chart.querySelectorAll('polyline').length,0)
 assert.equal(chart.querySelectorAll('circle').length,1)
 fireEvent.focus(chart.querySelectorAll('rect')[1])
 assert.match(screen.getByRole('status').textContent ?? '',/2026-10-02.*未上报/)
 assert.equal(new Set(paths).size,paths.length)
 assert.ok(paths.some(path=>new URLSearchParams(path.split('?')[1]).get('group_by')==='day'))
 assert.equal(screen.queryByRole('tab',{name:'供应商对账'}),null)
 assert.equal(screen.queryByRole('tab',{name:'模型价格'}),null)
 fireEvent.change(screen.getByLabelText('模型'),{target:{value:'model-a'}})
 fireEvent.click(screen.getByRole('button',{name:'查询用量'}))
 await waitFor(()=>assert.ok(paths.at(-1)?.includes('model=model-a')))
 const dates=new URLSearchParams(paths.at(-1)!.split('?')[1])
 for(const [label,dimension] of [['用户统计','user'],['设备统计','device'],['项目统计','project'],['供应商统计','provider'],['模型统计','model'],['日期统计','day']]) {
  const before=paths.length
  fireEvent.click(screen.getByRole('tab',{name:label}))
  await screen.findByRole('columnheader',{name:'缓存读取'})
  await waitFor(()=>assert.ok(paths.length>=before+1))
  const query=new URLSearchParams(paths.slice(before).find(path=>new URLSearchParams(path.split('?')[1]).get('group_by')===dimension)!.split('?')[1])
  assert.equal(query.get('group_by'),dimension)
  assert.equal(query.get('model'),'model-a')
  assert.equal(query.get('from_time'),dates.get('from_time'))
  assert.equal(query.get('to_time'),dates.get('to_time'))
  assert.equal(screen.getByRole('tab',{name:label}).getAttribute('aria-selected'),'true')
 }
 assert.match(document.body.textContent ?? '',/多种币种/)
 assert.match(document.body.textContent ?? '',/未上报/)
 assert.equal(paths.filter(path=>path.includes('/events?')).length,0)
})


test('dimension details reuse the time range, pagination resets after filtering and failed reports retry', async () => {
 const paths:string[]=[]
 let failed=false
 globalThis.fetch=async input=>{
  const path=String(input);paths.push(path)
  if(path.includes('/events?'))return Response.json({events:[],total:0})
  const params=new URLSearchParams(path.split('?')[1])
  if(params.get('group_by')==='user' && failed){failed=false;return new Response(null,{status:503})}
  return Response.json({event_count:30,unmetered_count:0,total_tokens:100,input_tokens:80,output_tokens:20,cache_read_tokens:0,cache_write_tokens:0,estimated_cost:'1.000',currency:'USD',group_total:30,groups:[{value:'alice',label:'用户显示名',event_count:30,unmetered_count:0,total_tokens:100,input_tokens:80,output_tokens:20,cache_read_tokens:0,cache_write_tokens:0,estimated_cost:'1.000',currency:'USD'}]})
 }
 render(<MemoryRouter><AdminUsagePage readOnly/></MemoryRouter>)
 await screen.findByRole('img',{name:'每日 Token 趋势（UTC）'})
 failed=true
 fireEvent.click(screen.getByRole('tab',{name:'用户统计'}))
 await screen.findByText(/用量汇总加载失败/)
 fireEvent.click(screen.getByRole('button',{name:'重试'}))
 await screen.findAllByText('用户显示名')
 fireEvent.click(screen.getByRole('button',{name:'下一页'}))
 await waitFor(()=>assert.equal(new URLSearchParams(paths.at(-1)!.split('?')[1]).get('offset'),'25'))
 await screen.findAllByText('用户显示名')
 fireEvent.change(screen.getByLabelText('模型'),{target:{value:'model-b'}})
 fireEvent.click(screen.getByRole('button',{name:'查询用量'}))
 await waitFor(()=>assert.equal(new URLSearchParams(paths.at(-1)!.split('?')[1]).get('offset'),'0'))
 await screen.findAllByText('用户显示名')
 const applied=new URLSearchParams(paths.at(-1)!.split('?')[1])
 fireEvent.click(screen.getByRole('button',{name:'查看明细'}))
 await screen.findByText('当前条件下没有计量事件。')
 const detail=new URLSearchParams(paths.at(-1)!.split('?')[1])
 assert.equal(detail.get('user_id'),'alice')
 assert.equal(detail.get('model'),'model-b')
 assert.equal(detail.get('from_time'),applied.get('from_time'))
 assert.equal(detail.get('to_time'),applied.get('to_time'))
 assert.equal(screen.getByRole('tab',{name:'用量明细'}).getAttribute('aria-selected'),'true')
})


test('compact report shows cache rate and comparisons, with the same scoped filters on history', async () => {
 const paths:string[]=[]
 globalThis.fetch=async input=>{
  const path=String(input);paths.push(path)
  const params=new URLSearchParams(path.split('?')[1])
  return Response.json({event_count:10,unmetered_count:0,input_tokens:100,output_tokens:20,cache_read_tokens:75,cache_write_tokens:0,total_tokens:120,estimated_cost:'0.1',currency:'USD',groups:[],group_total:0})
 }
 render(<MemoryRouter><AdminUsagePage readOnly/></MemoryRouter>)
 await screen.findByText('75.0%')
 await screen.findByText('环比 持平')
 await screen.findByText('同比 持平')
 assert.ok(screen.getByText('上月 Token'))
 assert.ok(screen.getByRole('img',{name:'模型用量占比'}))
 assert.ok(screen.getByRole('heading',{name:'用户用量分布'}))
 assert.equal(new Set(paths).size,paths.length)
 fireEvent.click(screen.getByText('更多筛选（用户、设备、项目、供应商、模型）'))
 fireEvent.change(screen.getByLabelText('用户 ID'),{target:{value:'scoped-user'}})
 fireEvent.click(screen.getByRole('button',{name:'查询用量'}))
 await screen.findByText('75.0%')
 await waitFor(()=>assert.equal(paths.filter(path=>path.includes('user_id=scoped-user')).length,6))
 assert.ok(paths.filter(path=>path.includes('user_id=scoped-user')).every(path=>path.includes('source=reported_by_device')))
})


test('failed history leaves the current compact report available and retries only comparison queries', async () => {
 const paths:string[]=[];let failHistory=true
 globalThis.fetch=async input=>{
  const path=String(input);paths.push(path)
  const params=new URLSearchParams(path.split('?')[1])
  if(!params.has('group_by') && failHistory)return new Response(null,{status:503})
  return Response.json({event_count:2,unmetered_count:0,input_tokens:100,output_tokens:20,cache_read_tokens:50,cache_write_tokens:0,total_tokens:120,estimated_cost:null,currency:null,groups:[],group_total:0})
 }
 render(<MemoryRouter><AdminUsagePage readOnly/></MemoryRouter>)
 await screen.findByText('50.0%')
 await screen.findByText('部分对比用量加载失败。')
 assert.ok(screen.getByRole('img',{name:'每日 Token 趋势（UTC）'}))
 const currentRequests=paths.filter(path=>new URLSearchParams(path.split('?')[1]).has('group_by')).length
 failHistory=false
 fireEvent.click(screen.getByRole('button',{name:'重试对比'}))
 await screen.findByText('同比 持平')
 assert.equal(paths.filter(path=>new URLSearchParams(path.split('?')[1]).has('group_by')).length,currentRequests)
 assert.equal(screen.queryByText('部分对比用量加载失败。'),null)
})
