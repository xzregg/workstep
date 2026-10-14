import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import type { TaskArtifact } from '../src/api/client'
import TaskStepIoPanel from '../src/components/TaskStepIoPanel'
import type { StepData } from '../src/components/TaskDetailView'

test('step IO shows rounds and opens only available input artifacts', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const step: StepData = { key: 'build', label: '构建', color: 'var(--accent)', prompt: '',
    inputs: [{ name: 'source', type: 'file' }], outputs: [] }
  const artifact = { name: 'source', step_key: 'prepare', round: 1, path: 'source.txt' } as TaskArtifact
  const calls: unknown[][] = []
  const render = (artifacts: TaskArtifact[]) => <I18nProvider><TaskStepIoPanel
    currentStep={step} steps={[step]} workflowConnections={[]} artifacts={artifacts}
    artifactInputSnapshots={[]} canChat={false} locale="zh-CN"
    onOpenArtifact={(...args) => calls.push(args)} /></I18nProvider>
  try {
    await act(async () => root.render(render([])))
    assert.equal(container.querySelector('.task-step-io-input')?.getAttribute('role'), null)
    await act(async () => root.render(render([artifact])))
    const input = container.querySelector<HTMLElement>('.task-step-io-input')!
    assert.equal(input.getAttribute('role'), 'button')
    await act(async () => input.click())
    assert.deepEqual(calls[0], ['source', 'prepare', 1, 'source.txt'])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('step IO explains queued repair, waiting downstream and blocked failures in read-only mode', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const step: StepData = { key: 'frontend', label: '前端开发', color: 'var(--accent)', prompt: '' }
  const render = (status: 'rework' | 'rework_waiting' | 'failed', error?: string) => (
    <I18nProvider><TaskStepIoPanel currentStep={step} steps={[step]}
      workflowConnections={[]} artifacts={[]} artifactInputSnapshots={[]}
      progress={{ status, error, visualState: status }} canChat={false}
      locale="zh-CN" onOpenArtifact={() => {}} /></I18nProvider>
  )
  try {
    await act(async () => root.render(render('rework')))
    assert.match(container.querySelector('[role="status"]')?.textContent || '', /已收到.*返工/)
    await act(async () => root.render(render('rework_waiting')))
    assert.match(container.querySelector('[role="status"]')?.textContent || '', /等待返工步骤完成/)
    await act(async () => root.render(render('failed', '后端开发缺少 API 文档')))
    assert.equal(container.querySelector('[role="alert"] .markdown-message')?.textContent, '后端开发缺少 API 文档')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('long review feedback is collapsed, renders Markdown and resets for another step', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const error = '## 检查结果\n\n- **缺少接口文档**\n- 请补充字段说明\n\n' + '补充审核说明。'.repeat(80)
  const render = (key: string, status: 'awaiting_review' | 'failed') => {
    const step: StepData = { key, label: key, color: 'var(--accent)', prompt: '' }
    return <I18nProvider><TaskStepIoPanel currentStep={step} steps={[step]}
      workflowConnections={[]} artifacts={[]} artifactInputSnapshots={[]}
      progress={{ status, error, visualState: status }} canChat={false}
      locale="zh-CN" onOpenArtifact={() => {}} /></I18nProvider>
  }
  try {
    await act(async () => root.render(render('backend', 'awaiting_review')))
    const details = container.querySelector('details')!
    assert.ok(details, 'long feedback has a disclosure')
    assert.equal(details.open, false)
    assert.match(details.querySelector('summary')?.textContent || '', /审核反馈|Review feedback/)
    assert.ok(details.querySelector('h2'))
    assert.equal(details.querySelectorAll('li').length, 2)
    assert.ok(details.querySelector('strong'))
    assert.ok(container.querySelector('.task-step-io-inputs'))
    await act(async () => { details.open = true })
    assert.equal(details.open, true)
    await act(async () => root.render(render('frontend', 'failed')))
    assert.equal(container.querySelector('details')!.open, false)
    assert.match(container.querySelector('[role="alert"] summary')?.textContent || '', /执行异常|Execution issue/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
