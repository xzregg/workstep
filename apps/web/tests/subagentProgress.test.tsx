import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProcessTrace from '../src/components/ProcessTrace'
import { buildMessageTimeline, timelineText } from '../src/utils/messageTimeline'
import { I18nProvider } from '../src/i18n'

const frame = (status: string, events: object[] = []) => ({
  type: 'CUSTOM', name: 'workstep.subagent', value: { task_id: 'child-1', description: 'Explorer', status, events },
})
const events = [
  frame('running', [{ type: 'TEXT_MESSAGE_CHUNK', delta: 'Checking **files**' }]),
  frame('running', [{ type: 'REASONING_MESSAGE_CHUNK', delta: 'Considering paths' }]),
  frame('running', [{ type: 'TOOL_CALL_START', toolCallId: 'read', toolCallName: 'Read' }]),
  frame('running', [{ type: 'TOOL_CALL_RESULT', toolCallId: 'read', output: 'contents' }]),
  frame('running', [{ type: 'TEXT_MESSAGE_CHUNK', delta: 'Found answer' }]),
]

test('subagent live messages remain nested and survive replay', () => {
  const timeline = buildMessageTimeline(events)
  assert.equal(timelineText(timeline), '')
  const child = timeline[0]
  assert.equal(child.type, 'subagent')
  if (child.type !== 'subagent') return
  assert.equal(child.activity.events?.length, 5)
  assert.deepEqual(buildMessageTimeline(JSON.parse(JSON.stringify(events))), timeline)
})

for (const width of [390, 1280]) {
  test(`subagent opens live output and folds only when done at ${width}`, async () => {
    const window = new Window({ width, url: 'http://localhost' })
    Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    const root = createRoot(container)
    const render = (done: boolean) => root.render(<I18nProvider><ProcessTrace running events={done ? [...events, frame('completed')] : events} /></I18nProvider>)
    try {
      await act(async () => render(false))
      const child = container.querySelector<HTMLDetailsElement>('.subagent-timeline')!
      assert.ok(child)
      assert.equal(child.open, true)
      assert.equal(child.querySelector('strong')?.textContent, 'files')
      const thinking = child.querySelector('.process-trace-thinking')
      assert.ok(thinking)
      assert.equal(thinking.querySelector('p'), null)
      assert.equal(thinking.textContent, 'Considering paths')
      assert.equal(child.querySelector('.subagent-event-markdown p'), null)
      assert.ok(child.querySelector('.subagent-event-markdown .markdown-compact-paragraph'))
      assert.match(child.textContent ?? '', /Considering paths/)
      assert.match(child.textContent ?? '', /Found answer/)
      await act(async () => render(true))
      assert.equal(child.open, false)
      await act(async () => { child.open = true; child.dispatchEvent(new window.Event('toggle')) })
      await act(async () => render(true))
      assert.equal(child.open, true)
    } finally {
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  })
}


test('native task IDs and parent tool IDs share one child timeline', () => {
  const timeline = buildMessageTimeline([
    {type:'CUSTOM', name:'workstep.subagent', value:{task_id:'native-task',tool_use_id:'tool',status:'running'}},
    {type:'CUSTOM', name:'workstep.subagent', value:{task_id:'tool',tool_use_id:'tool',status:'running',events:[{type:'TEXT_MESSAGE_CHUNK',delta:'Reading'}]}},
    {type:'CUSTOM', name:'workstep.subagent', value:{task_id:'native-task',status:'completed'}},
  ])
  assert.equal(timeline.length, 1)
  const child = timeline[0]
  assert.equal(child.type, 'subagent')
  if (child.type !== 'subagent') return
  assert.equal(child.activity.status, 'completed')
  assert.equal(child.activity.events?.[0].delta, 'Reading')
})
