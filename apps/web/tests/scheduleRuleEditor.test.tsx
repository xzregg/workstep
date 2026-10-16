import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ScheduleRuleEditor from '../src/components/ScheduleRuleEditor'
import type { ScheduleRule } from '../src/api/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('shared frequency editor uses project tabs and edits intervals, weekdays and effective dates', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale:'zh-CN' })
  let current: ScheduleRule = {kind:'minutes',every:10,timezone:'Asia/Shanghai'}
  function Harness() {
    const [rule, setRule] = useState(current)
    return <ScheduleRuleEditor value={rule} onChange={value => {current=value;setRule(value)}} />
  }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const click = async (text: string) => act(async () => {
    const button = [...container.querySelectorAll('button')].find(button => button.textContent === text)
    assert.ok(button,text);button.click()
  })
  const set = async (selector: string, value: string) => act(async () => {
    const input = container.querySelector<HTMLInputElement>(selector)!
    assert.ok(input,selector)
    const proto = input.tagName==='SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(input,value)
    input.dispatchEvent(new window.Event(input.tagName==='SELECT' ? 'change':'input',{bubbles:true}))
  })
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.equal(container.querySelectorAll('.schedule-frequency-tabs button').length,3)
    assert.deepEqual([...container.querySelectorAll('select option')].map(option=>option.getAttribute('value')),['minutes','daily','weekly','monthly','cron'])
    await set('input[type="number"]','15')
    assert.equal(current.kind==='minutes' && current.every,15)
    await set('[aria-label="开始日期"]','2026-10-20')
    await set('[aria-label="结束日期"]','2026-10-21')
    await set('[aria-label="开始日期"]','2026-10-22')
    assert.equal(current.end_date,undefined)
    await click('按间隔')
    assert.equal(current.kind,'interval')
    assert.equal(current.start_date,'2026-10-22')
    assert.equal(container.querySelectorAll('.schedule-weekday-tabs button').length,7)
    await click('周一')
    assert.ok('weekdays' in current && !current.weekdays.includes(1))
    await click('单次')
    assert.equal(current.kind,'once')
    assert.ok(container.querySelector('input[type="datetime-local"]'))
    assert.equal(container.querySelector('input[type="date"]'),null)
    await click('周期')
    assert.equal(current.kind,'daily')
    assert.equal(current.timezone,'Asia/Shanghai')
    await set('select','monthly')
    await set('[aria-label="每月日期"]','12')
    assert.deepEqual(current.kind==='monthly' && current.monthdays,[12])
  } finally {await act(async()=>root.unmount());container.remove();await window.happyDOM.close()}
})
