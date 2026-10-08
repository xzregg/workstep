import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { taskApi, type ActionProposal } from '../src/api/client'
import { CoordinatorProposalCard } from '../src/components/CoordinatorProposalCard'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { installDomEnvironment } from './helpers/domEnv'

test('rerun proposal discloses context reset before confirmation', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const proposal = {
    id: 'reset-proposal', type: 'rerun_from_step', status: 'pending',
    target_step_key: 'build', payload: { reset_session: true },
  } as unknown as ActionProposal
  useLocaleStore.setState({ locale: 'zh-CN' })
  try {
    await act(async () => root.render(<I18nProvider>
      <CoordinatorProposalCard proposal={proposal} taskId="task-1" projectId="project-1" onChanged={() => {}} />
    </I18nProvider>))
    assert.match(container.textContent || '', /重置目标步骤上下文，以新会话运行/)
    await act(async () => root.render(<I18nProvider>
      <CoordinatorProposalCard proposal={{ ...proposal, payload: {} }} taskId="task-1" projectId="project-1" onChanged={() => {}} />
    </I18nProvider>))
    assert.doesNotMatch(container.textContent || '', /重置目标步骤上下文/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('failed duplicate Action proposal keeps a visible overwrite retry button', async () => {
  const { window } = installDomEnvironment()
  const original = taskApi.confirmAction
  const calls: unknown[][] = []
  const proposal = {
    id: 'proposal-1', type: 'create_workflow_action', status: 'failed',
    error: '流程中已存在同名 Action', impact: { summary: '创建快捷按钮' },
    payload: { workflow_id: 'workflow-1', action_id: 'restart', label: '重启',
      script_path: 'start.sh', script_content: '#!/bin/sh\necho ready\n', cwd_mode: 'task' },
  } as unknown as ActionProposal
  taskApi.confirmAction = async (...args: Parameters<typeof original>) => {
    calls.push(args)
    return { ...proposal, status: 'succeeded' }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  useLocaleStore.setState({ locale: 'zh-CN' })
  try {
    await act(async () => root.render(<I18nProvider>
      <CoordinatorProposalCard proposal={proposal} taskId="task-1" projectId="project-1" onChanged={() => {}} />
    </I18nProvider>))
    assert.match(container.textContent || '', /流程中已存在同名 Action/)
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('覆盖并重试'))
    assert.ok(retry)
    await act(async () => retry.click())
    assert.equal(calls.length, 1)
    assert.equal(calls[0][4], true)
  } finally {
    taskApi.confirmAction = original
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
