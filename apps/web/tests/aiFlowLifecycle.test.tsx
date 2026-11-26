import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { workflowGenApi } from '../src/api/client'
import AiFlowChat, { type AiFlowChatHandle } from '../src/components/AiFlowChat'
import { useWorkflowGenStore } from '../src/stores/workflowGenStore'

for (const [failStop, remap] of [[false, false], [true, false], [false, true]]) test(`discard waits for submission (remap=${remap}) and ${failStop ? 'preserves session when stop fails' : 'stops accepted session'}`, async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(globalThis, 'CSSStyleSheet', { configurable: true, value: window.CSSStyleSheet })
  const originalFetch = globalThis.fetch, originalChat = workflowGenApi.chat, originalStop = workflowGenApi.stop
  const el = document.body.appendChild(document.createElement('div')), root = createRoot(el)
  const ref = createRef<AiFlowChatHandle>()
  let accept!: (value: any) => void
  let sid = ''
  const stops: string[] = []
  try {
    useLocaleStore.setState({ locale: 'zh-CN' }); useWorkflowGenStore.setState({ sessions: {} })
    globalThis.fetch = (async () => new Response(JSON.stringify({ assistants: [], providers: [], skills: [], items: [] }), { headers: { 'Content-Type': 'application/json' } })) as never
    workflowGenApi.chat = (async (_p, _c, session) => { sid = session!; return await new Promise(done => { accept = done }) }) as never
    workflowGenApi.stop = (async (session, project) => { assert.equal(project, 'p'); stops.push(session); return { stopped: !failStop } }) as never
    await act(async () => root.render(<I18nProvider><AiFlowChat ref={ref} projectId="p" initialMessage="创建发布流程" /></I18nProvider>))
    assert.equal(ref.current?.hasContent(), true)
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
    let discarded = false
    let failure = ''
    let discard!: Promise<void>
    await act(async () => { discard = ref.current!.discard().then(() => { discarded = true }, error => { failure = error.message }) })
    assert.equal(discarded, false)
    assert.equal(stops.length, 0, 'must wait for the backend to accept before stopping')
    await act(async () => {
      accept({session_id:remap ? 'canonical' : sid,turn_id:'u',assistant_message_id:'a',status:'queued'})
      await discard
    })
    assert.deepEqual(stops, [remap ? 'canonical' : sid])
    if (remap) assert.equal(Boolean(useWorkflowGenStore.getState().sessions[sid]), false)
    assert.equal(discarded, !failStop)
    if (failStop) {
      assert.match(failure, /停止失败/)
      assert.equal(useWorkflowGenStore.getState().sessions[sid]?.running, true)
    } else assert.equal(Boolean(useWorkflowGenStore.getState().sessions[sid]), false)
  } finally {
    await act(async () => root.unmount()); el.remove()
    workflowGenApi.chat = originalChat; workflowGenApi.stop = originalStop; globalThis.fetch = originalFetch
    useWorkflowGenStore.setState({sessions:{}}); await window.happyDOM.close()
  }
})
