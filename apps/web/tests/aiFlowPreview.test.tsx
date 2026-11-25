import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { workflowGenApi } from '../src/api/client'
import AiFlowChat from '../src/components/AiFlowChat'
import { useWorkflowGenStore } from '../src/stores/workflowGenStore'

test('validated auto-apply proposals preview first and canceled confirmation never marks applied', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(globalThis, 'CSSStyleSheet', { configurable: true, value: window.CSSStyleSheet })
  const originalFetch = globalThis.fetch, originalChat = workflowGenApi.chat
  const el = document.body.appendChild(document.createElement('div')), root = createRoot(el)
  const previews: any[] = [], applied: any[] = []
  let sid = '', resolve: (value: boolean) => void = () => {}
  const base = { nodes: [{id:1,type:'write',title:'撰写'}], connections:[] }
  const proposed = { nodes: [{id:1,type:'write',title:'归纳'}], connections:[] }
  try {
    useLocaleStore.setState({ locale: 'zh-CN' }); useWorkflowGenStore.setState({ sessions: {} })
    globalThis.fetch = (async () => new Response(JSON.stringify({ assistants: [], providers: [], skills: [], items: [] }), { headers: { 'Content-Type': 'application/json' } })) as never
    workflowGenApi.chat = (async (_p, _c, session) => { sid = session!; return {session_id:sid,turn_id:'u',assistant_message_id:'a',status:'queued'} }) as never
    await act(async () => root.render(<I18nProvider><AiFlowChat projectId="p" initialMessage="改成归纳"
      getCanvasSteps={() => base} onPreview={steps => previews.push(steps)}
      onProposal={steps => { applied.push(steps); return new Promise<boolean>(done => { resolve = done }) }} /></I18nProvider>))
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
    await act(async () => {
      useWorkflowGenStore.getState().handleWsEvent({type:'CUSTOM',name:'workstep.flow_proposals',channel:'flow_gen',session_id:sid,messageId:'a',value:{proposals:[{
        id:'p1',title:'主题归纳',summary:'调整归纳方式',nodeCount:1,autoApply:true,steps:proposed,
        patch:{upsertNodes:proposed.nodes},stepChanges:[{id:1,key:'write',title:'归纳',change:'updated'}],
      }]}})
      useWorkflowGenStore.getState().markStopped(sid)
    })
    assert.deepEqual(previews.at(-1), proposed)
    assert.equal(applied.length,0,'autoApply must not bypass the user in preview-enabled editors')
    const apply = el.querySelector<HTMLButtonElement>('[data-apply-proposal]')!
    await act(async () => apply.click())
    assert.equal(applied.length,1)
    assert.doesNotMatch(apply.textContent || '',/已应用/)
    await act(async () => resolve(false))
    assert.equal(apply.disabled,false,'a canceled overwrite confirmation is retryable')
    await act(async () => apply.click())
    await act(async () => resolve(true))
    assert.match(apply.textContent || '',/已应用/)
    assert.deepEqual(base.nodes.map(n => n.title),['撰写'])
  } finally {
    await act(async () => root.unmount()); el.remove(); workflowGenApi.chat=originalChat; globalThis.fetch=originalFetch
    useWorkflowGenStore.setState({sessions:{}}); await window.happyDOM.close()
  }
})
