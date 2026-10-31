import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Window } from 'happy-dom'
import { ActivityHeatmap, activityCalendar, activityDateRange } from '@workstep/gateway-ui/ActivityHeatmap'

const labels = { title: '使用活跃情况', previous: '上一年', next: '下一年', less: '少', more: '多', outside: '不在统计范围', unknown: '未上报', calls: '次调用', days: '活跃天数', hint: '仅统计所选时间范围' }
test('calendar preserves leap days, Monday alignment, missing metering and range boundaries', () => {
 const days = activityCalendar(2024, [{date:'2024-02-29',count:2,tokens:null}], '2024-02-01','2024-03-01')
 assert.equal(days.length,366)
 assert.equal(days[0].slot,0)
 assert.equal(days.find(day=>day.date==='2024-02-29')!.tokens,null)
 assert.equal(days.find(day=>day.date==='2024-02-29')!.count,2)
 assert.equal(days.find(day=>day.date==='2024-02-28')!.count,0)
 assert.equal(days.find(day=>day.date==='2024-03-01')!.outside,true)
 assert.equal(activityCalendar(2023,[], '2023-01-01','2024-01-01')[0].slot,6)
})
test('heatmap supports focus details, empty days and year navigation', async () => {
 const window = new Window()
 Object.assign(globalThis,{window,document:window.document,navigator:window.navigator,IS_REACT_ACT_ENVIRONMENT:true})
 const container=document.body.appendChild(document.createElement('div'))
 const root=createRoot(container)
 try {
  await act(async()=>root.render(<ActivityHeatmap start="2023-01-01" end="2025-01-01" locale="zh-CN" labels={labels} rows={[{date:'2024-02-29',count:2,tokens:null}]}/>))
  assert.equal(container.querySelectorAll('[data-date]').length,366)
  const target=container.querySelector<HTMLElement>('[data-date="2024-02-29"]')!
  await act(async()=>target.focus())
  assert.match(container.querySelector('[role="status"]')!.textContent!,/2024-02-29.*2.*未上报/)
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="下一年"]')!.disabled,true)
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="上一年"]')!.click())
  assert.equal(container.querySelectorAll('[data-date]').length,365)
 } finally {await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('date range includes partial last days and respects local year boundaries', () => {
 assert.deepEqual(activityDateRange('2024-12-31T16:00:00Z','2025-01-01T16:00:00Z','Asia/Shanghai'),{start:'2025-01-01',end:'2025-01-02'})
 assert.deepEqual(activityDateRange('2024-02-28T00:00:00Z','2024-02-29T12:00:00Z'),{start:'2024-02-28',end:'2024-03-01'})
})
