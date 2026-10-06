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

test('Codex child activity and late results render as three separate completed agents', async () => {
  const window = new Window({ url: 'http://localhost' })
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  const root = createRoot(container)
  const frames = [1, 2, 3].flatMap((number) => [
    { type: 'CUSTOM', name: 'workstep.subagent', value: {
      task_id: `child-${number}`, description: `/root/test_${number}`, status: 'running', stage: 'started',
      agent_name: `test_${number}`, agent_path: `/root/test_${number}`, prompt: `回复 ${number}`, started_at: 1700000002000,
    } },
    { type: 'CUSTOM', name: 'workstep.subagent', value: {
      task_id: `child-${number}`, description: `/root/test_${number}`, status: 'completed', stage: 'completed', ended_at: 1700000005500,
    } },
    { type: 'CUSTOM', name: 'workstep.subagent', value: {
      task_id: `child-${number}`, status: 'completed', stage: 'progress',
      result: String(number),
      events: [{ type: 'TEXT_MESSAGE_CHUNK', delta: String(number) }],
    } },
  ])
  assert.equal(timelineText(buildMessageTimeline(frames)), '')
  assert.deepEqual(buildMessageTimeline(JSON.parse(JSON.stringify(frames))), buildMessageTimeline(frames))
  try {
    await act(async () => root.render(<I18nProvider><ProcessTrace events={frames} /></I18nProvider>))
    await act(async () => {
      container.querySelector('.process-trace-session-summary')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    const children = [...container.querySelectorAll<HTMLDetailsElement>('.subagent-timeline')]
    assert.equal(children.length, 3)
    for (const [index, child] of children.entries()) {
      assert.match(child.querySelector('summary')!.textContent ?? '', new RegExp(`test_${index + 1}`))
      assert.doesNotMatch(child.querySelector('summary')!.textContent ?? '', /\/root\//)
      assert.match(child.querySelector('.subagent-duration')!.textContent ?? '', /3秒/)
      assert.ok(child.classList.contains('llm-tool-call-done'))
      await act(async () => { child.open = true; child.dispatchEvent(new window.Event('toggle')) })
      assert.equal(child.querySelector('.subagent-identity code')!.textContent, `/root/test_${index + 1}`)
      assert.equal(child.querySelector('.subagent-prompt pre')!.textContent, `回复 ${index + 1}`)
      assert.equal(child.querySelector('.subagent-result pre')!.textContent, String(index + 1))
      assert.equal(child.querySelector('.subagent-event-markdown'), null)
      assert.equal(child.querySelector('.task-status-spinner'), null)
    }
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

for (const width of [390, 1280]) {
  test(`only the latest subagent stays open at ${width}`, async () => {
    const window = new Window({ width, url: 'http://localhost' })
    Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    const root = createRoot(container)
    const render = (done: boolean) => root.render(<I18nProvider><ProcessTrace running events={done ? [...events, frame('completed')] : events} /></I18nProvider>)
    try {
      await act(async () => render(false))
      await act(async () => {
        container.querySelector<HTMLDivElement>('.process-trace-session-summary')!
          .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
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
      assert.equal(child.open, true)
      await act(async () => { child.open = false; child.dispatchEvent(new window.Event('toggle')) })
      await act(async () => render(true))
      assert.equal(child.open, false)
    } finally {
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  })
}

test('a newer running subagent folds the previous one and opens only itself', async () => {
  const window = new Window({ url: 'http://localhost' })
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  const root = createRoot(container)
  const twoChildren = [
    frame('running'),
    { type: 'CUSTOM', name: 'workstep.subagent', value: { task_id: 'child-2', description: 'Builder', status: 'running' } },
  ]
  try {
    await act(async () => root.render(<I18nProvider><ProcessTrace running events={[frame('running')]} /></I18nProvider>))
    await act(async () => {
      container.querySelector<HTMLDivElement>('.process-trace-session-summary')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(
      [...container.querySelectorAll<HTMLDetailsElement>('.subagent-timeline')].map((child) => child.open),
      [true],
    )

    await act(async () => root.render(<I18nProvider><ProcessTrace running events={twoChildren} /></I18nProvider>))
    assert.deepEqual(
      [...container.querySelectorAll<HTMLDetailsElement>('.subagent-timeline')].map((child) => child.open),
      [false, true],
    )
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


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
