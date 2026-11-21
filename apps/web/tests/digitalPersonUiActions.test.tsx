import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError, chatSessionApi, type ChatSessionDetail } from '../src/api/client'
import { useProjectStore } from '../src/stores/projectStore'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'
import type { AssistantChatMessage } from '../src/stores/assistantStore'
import { resolveDigitalPersonConversation, useDigitalPersonUiActions } from '../src/components/digital-person/useDigitalPersonUiActions'
import { installDomEnvironment } from './helpers/domEnv'

const reply = (id: string, action: object, status: AssistantChatMessage['status'] = 'succeeded'): AssistantChatMessage => ({
  id, role: 'assistant', status, content: ['```workstep-ui', JSON.stringify(action), '```'].join('\n'),
})

test('exact opening checks the requested project and session via one authorized detail request', async () => {
  const { window } = installDomEnvironment()
  const originalGet = chatSessionApi.get
  const originalList = chatSessionApi.list
  const originalProjects = useProjectStore.getState().projects
  const settings = useUserSettingsStore.getState()
  useUserSettingsStore.setState({ loaded: true, loading: false })
  useProjectStore.setState({ projects: [{ id: 'p', name: '网站', path: '/site', workflows: [] }] })
  const detail: ChatSessionDetail = { id: 'execution', project_id: 'p', title: '真实的委派标题',
    engine: 'pydantic_ai', messages: [], message_count: 0, running: true }
  const lookups: string[][] = []
  let problem: Error | undefined
  let result = detail
  chatSessionApi.list = async () => assert.fail('ID lookup must not list sessions')
  chatSessionApi.get = async (sessionId, projectId) => {
    lookups.push([sessionId, projectId])
    if (problem) throw problem
    return result
  }
  const action = { action: 'conversation.open', project_id: 'p', session_id: 'execution' } as const
  try {
    const opened = await resolveDigitalPersonConversation(action, 'source')
    assert.ok('target' in opened)
    assert.equal(opened.target.title, detail.title)
    assert.equal(opened.target.sessionId, detail.id)
    assert.equal(opened.target.initialHistory?.detail, detail)
    assert.deepEqual(lookups, [['execution', 'p']])
    assert.deepEqual(await resolveDigitalPersonConversation({ ...action, project_id: 'unknown' }, 'source'), { issue: 'missingTarget' })
    assert.deepEqual(await resolveDigitalPersonConversation({ ...action, session_id: 'source' }, 'source'), { issue: 'missingTarget' })
    assert.equal(lookups.length, 1)
    for (const [status, issue] of [[404, 'missingTarget'], [403, 'forbidden'], [401, 'forbidden'], [503, 'detailUnavailable']] as const) {
      problem = new ApiError('session error', status)
      assert.deepEqual(await resolveDigitalPersonConversation(action, 'source'), { issue })
    }
    problem = undefined
    result = { ...detail, project_id: 'another' }
    assert.deepEqual(await resolveDigitalPersonConversation(action, 'source'), { issue: 'missingTarget' })
  } finally {
    chatSessionApi.get = originalGet
    chatSessionApi.list = originalList
    useProjectStore.setState({ projects: originalProjects })
    useUserSettingsStore.setState({ loaded: settings.loaded, loading: settings.loading })
    await window.happyDOM.close()
  }
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
