import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { workflowGenApi } from '../src/api/client'
import AiFlowChat from '../src/components/AiFlowChat'
import { useWorkflowGenStore } from '../src/stores/workflowGenStore'

const { window } = installDomEnvironment()
const previousStyleSheet = Object.getOwnPropertyDescriptor(globalThis, 'CSSStyleSheet')
Object.defineProperty(globalThis, 'CSSStyleSheet', { configurable: true, value: window.CSSStyleSheet })
after(async () => {
  await window.happyDOM.close()
  if (previousStyleSheet) Object.defineProperty(globalThis, 'CSSStyleSheet', previousStyleSheet)
  else Reflect.deleteProperty(globalThis, 'CSSStyleSheet')
})

for (const kind of ['missing', 'valid', 'clarification'] as const) {
  test(`workflow button ${kind} routes to the appropriate action`, async () => {
    const originalFetch = globalThis.fetch
    const originalChat = workflowGenApi.chat
    const element = document.body.appendChild(document.createElement('div'))
    const root = createRoot(element)
    const steps = { nodes: [{ id: 1, type: 'req', title: '需求' }], connections: [] }
    const applied: unknown[] = []
    const sent: string[] = []
    let sessionId = ''
    try {
      useLocaleStore.setState({ locale: 'zh-CN' })
      useWorkflowGenStore.setState({ sessions: {} })
      globalThis.fetch = (async () => new Response(JSON.stringify({
        assistants: [], providers: [], skills: [], items: [],
      }), { headers: { 'Content-Type': 'application/json' } })) as never
      workflowGenApi.chat = (async (_project, content, session) => {
        sessionId = session!
        sent.push(content)
        return { session_id: sessionId, turn_id: 'user', assistant_message_id: 'reply', status: 'queued' }
      }) as never
      await act(async () => root.render(<I18nProvider>
        <AiFlowChat projectId="p" initialMessage="调整流程" onProposal={(value) => applied.push(value)} />
      </I18nProvider>))
      await act(async () => document.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
      const messages = [
        { createSurface: { surfaceId: 'choice', catalogId: 'default' } },
        { updateComponents: { surfaceId: 'choice', components: [
          { id: 'root', component: 'Column', children: ['apply'] },
          { id: 'apply', component: 'Button', text: '应用规则', action: { event: {
            name: kind === 'clarification' ? 'submit_brief' : 'apply_flow',
            context: kind === 'valid' ? { proposal: 1, stepsJson: JSON.stringify(steps) } : { proposal: 1 },
          } } },
        ] } },
      ]
      await act(async () => {
        useWorkflowGenStore.getState().hydrateSession(sessionId, [{
          id: 'historical-reply', role: 'assistant', status: 'stopped',
          content: `加入规则\n\`\`\`a2ui\n${messages.map((value) => JSON.stringify(value)).join('\n')}\n\`\`\``,
        }])
        useWorkflowGenStore.getState().markStopped(sessionId)
      })
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent?.trim() === '应用规则')
      assert.ok(button, 'the model-authored action must be rendered')
      const beforeCount = useWorkflowGenStore.getState().sessions[sessionId].messages.length
      await act(async () => button.click())
      if (kind === 'clarification') {
        assert.equal(sent.length, 2, 'clarification still sends answers to the assistant')
      } else {
        assert.equal(sent.length, 1, 'apply must never become a new chat turn')
        assert.equal(useWorkflowGenStore.getState().sessions[sessionId].messages.length, beforeCount)
        assert.equal(useWorkflowGenStore.getState().sessions[sessionId].running, false)
        if (kind === 'valid') assert.deepEqual(applied, [steps])
        else {
          assert.deepEqual(applied, [])
          assert.match(document.body.textContent || '', /方案数据不完整.*重新生成/)
        }
      }
    } finally {
      await act(async () => root.unmount())
      element.remove()
      workflowGenApi.chat = originalChat
      globalThis.fetch = originalFetch
      useWorkflowGenStore.setState({ sessions: {} })
    }
  })
}
