import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomEnvironment } from './helpers/domEnv'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskDetailPage from '../src/components/TaskDetailPage'
import { I18nProvider } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'

test('readonly project detail preserves history and viewing without exposing its composer', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://d-device.localhost:8700/')
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ detail: 'scope denied' }, { status: 403 })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  const render = () => root.render(<I18nProvider><TaskDetailPage
    locale="zh-CN" durationNowMs={Date.now()} currentStep={{ key: 'do', label: 'Execute', color: 'blue', prompt: '', inputs: [], outputs: [] }}
    activeStep={{ key: 'do', label: 'Execute', color: 'blue', prompt: '', inputs: [], outputs: [] }} currentStepColor="blue" activeStepColor="blue"
    taskCompleted={false} runningSteps={[]} executionStepModel="" sessionIdForStep={() => null}
    onViewingPromptChange={() => {}} projectId="host-1" task={{ id: 'task-1', title: 'Visible task', status: 'ready',
      steps: [], created_at: '2026-01-01T00:00:00Z' }}
    steps={[]} stepProgress={[]} selectedStep={0} onStepClick={() => {}}
    historyMessages={[]} liveMessages={{}} events={[]} content=""
    reviews={[]} artifacts={[]} onSend={() => {}} onSendPrompt={() => {}}
    prompt="draft" onPromptChange={() => {}} descriptionEditable reviewConfigEditable
    readCapabilities={{ artifactDirectory: '', resolveAssetUrl: value => value,
      filePreview: { load: async () => ({}) as never, rawUrl: value => value }, loadMessageEvents: () => {}, openArtifact: () => {},
      loadExecutionReport: async () => ({}) as never, browseGitWorkspace: async () => ({}) as never }}
  /></I18nProvider>)
  try {
    const session = { device_id: 'device', device_name: 'PC', username: 'Alice',
      gateway_url: 'http://localhost:8700/devices', project_id: 'p1', host_project_id: 'host-1',
      access_level: 'read' as const, task_create: false, share_create: false, can_manage_project_access: false }
    useGatewaySessionStore.setState({ session })
    await act(async () => render())
    const readonly = element.innerHTML
    assert.match(readonly, /Visible task/)
    assert.match(readonly, /task-chat-history/)
    assert.doesNotMatch(readonly, /class="chat-input/)
    await act(async () => { useGatewaySessionStore.setState({ session: { ...session, access_level: 'edit' } }); render() })
    assert.match(element.innerHTML, /class="chat-input/)
  } finally {
    await act(async () => { root.unmount(); useGatewaySessionStore.setState({ session: null }) })
    element.remove()
    globalThis.fetch = oldFetch
    await window.happyDOM.close()
  }
})
