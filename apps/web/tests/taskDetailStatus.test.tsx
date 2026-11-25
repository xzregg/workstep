import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import TaskDetailHeader from '../src/components/TaskDetailHeader'
import TaskDetailView from '../src/components/TaskDetailView'

test('detail header explains review waits instead of showing the pipeline pause', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const cases = [
    { steps: [{ status: 'awaiting_review' }], completed: false, expected: '等待审核' },
    { steps: [{ status: 'reviewing' }], completed: false, expected: '审核中' },
    { steps: [], completed: false, expected: '失败' },
    { steps: [{ status: 'passed' }], completed: true, expected: '已完成' },
  ]
  try {
    for (const item of cases) {
      await act(async () => root.render(<I18nProvider><TaskDetailHeader
        task={{ id: 'remote-task', title: '审核状态', status: 'paused', steps: item.steps as any, created_at: '2026-01-01T00:00:00Z' }}
        locale="zh-CN" activeStep={{ key: 'review', label: '验收', color: 'blue', prompt: '', inputs: [], outputs: [] }}
        activeStepColor="blue" taskCompleted={item.completed} />
      </I18nProvider>))
      assert.equal(container.querySelector('[data-status]')?.textContent, item.expected)
    }
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('debug details identify the task and put actions beside the primary tabs', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const step = { key: 'do', label: '执行', color: 'blue', prompt: '', inputs: [], outputs: [] }
  const render = (isDebug: boolean) => root.render(<I18nProvider><TaskDetailView
    locale="zh-CN" durationNowMs={Date.now()} currentStep={step} activeStep={step}
    currentStepColor="blue" activeStepColor="blue" taskCompleted={false}
    runningSteps={[]} executionStepModel="" sessionIdForStep={() => null} onViewingPromptChange={() => {}}
    projectId="project-1" gitEnabled task={{ id: 'task-1', title: '任务标题', description: '任务内容',
      is_debug: isDebug, status: 'ready', steps: [], created_at: '2026-01-01T00:00:00Z' }}
    steps={[step]} stepProgress={[]} selectedStep={0} onStepClick={() => {}}
    historyMessages={[]} liveMessages={{}} events={[]} content="" reviews={[]} artifacts={[]}
    onSend={() => {}} onSendPrompt={() => {}} prompt="" onPromptChange={() => {}}
    debugWorkflowTools={isDebug ? <div data-debug-tools>调试操作</div> : undefined}
    workflowTools={<div data-workflow-tools>流程操作</div>}
  /></I18nProvider>)
  try {
    await act(async () => render(true))
    assert.equal(host.querySelector('.task-detail-header-primary')?.firstElementChild?.textContent, '调试')
    assert.ok(host.querySelector('.task-detail-primary-tabs-actions [data-debug-tools]'))
    assert.ok(host.querySelector('.task-detail-step-panel [data-debug-tools]') === null)
    assert.deepEqual(Array.from(host.querySelectorAll('.task-detail-primary-tabs [role=tab]'), tab => tab.textContent).slice(0, 2),
      ['任务详情', 'Git工作区'])
    await act(async () => render(false))
    assert.ok(host.querySelector('.task-detail-debug-badge') === null)
    assert.ok(host.querySelector('[data-debug-tools]') === null)
    assert.ok(host.querySelector('.task-detail-step-panel [data-workflow-tools]'))
  } finally {
    await act(async () => root.unmount())
    host.remove()
    await window.happyDOM.close()
  }
})
