import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { chatSessionApi } from '../src/api/client'
import { useProjectStore } from '../src/stores/projectStore'
import type { AssistantChatMessage } from '../src/stores/assistantStore'
import { useDigitalPersonUiActions } from '../src/components/digital-person/useDigitalPersonUiActions'
import { installDomEnvironment } from './helpers/domEnv'

const reply = (id: string, action: object, status: AssistantChatMessage['status'] = 'succeeded'): AssistantChatMessage => ({
  id, role: 'assistant', status, content: ['```workstep-ui', JSON.stringify(action), '```'].join('\n'),
})

test('applies only a complete acknowledged reply once and ignores late results after leaving', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const originalList = chatSessionApi.list
  const originalProjects = useProjectStore.getState().projects
  useProjectStore.setState({ projects: [{ id: 'p', name: '网站', path: '/site', workflows: [] }] })
  const target = { id: 'target', title: '发布复盘' } as Awaited<ReturnType<typeof originalList>>['sessions'][number]
  let lookups = 0
  let resolvePending: ((value: Awaited<ReturnType<typeof originalList>>) => void) | undefined
  chatSessionApi.list = async () => {
    lookups++
    if (lookups === 3) return new Promise(resolve => { resolvePending = resolve })
    return { sessions: lookups === 1 ? [target, { ...target, id: 'other' }] : [target] }
  }
  let ui: ReturnType<typeof useDigitalPersonUiActions>
  function Harness({ active, message }: { active: boolean; message?: AssistantChatMessage }) {
    ui = useDigitalPersonUiActions(active, 'source', message)
    return null
  }
  const render = (message?: AssistantChatMessage, active = true) => act(async () => root.render(<Harness active={active} message={message}/>))
  const open = { action: 'conversation.open', title: '发布复盘', project: '网站' }
  try {
    await render()
    await render(reply('a', open, 'running'))
    assert.equal(lookups, 0)
    await render(reply('a', open))
    assert.equal(ui!.issue, 'ambiguous')
    assert.equal(ui!.panel, null)
    await render(reply('b', open))
    assert.equal(ui!.panel?.sessionId, 'target')
    await render(reply('b', open))
    assert.equal(lookups, 2)
    await render(reply('c', { action: 'window.close' }))
    assert.equal(ui!.panel?.closing, true)
    await act(async () => ui!.finishClosing('b'))
    assert.equal(ui!.panel, null)

    await render(reply('d', open))
    await render(reply('d', open), false)
    await act(async () => resolvePending?.({ sessions: [target] }))
    await render(reply('d', open))
    assert.equal(ui!.panel, null)
    assert.equal(lookups, 3)
  } finally {
    await act(async () => root.unmount())
    chatSessionApi.list = originalList
    useProjectStore.setState({ projects: originalProjects })
    await window.happyDOM.close()
  }
})
