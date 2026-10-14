import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { CoordinatorProposalCard } from '../src/components/CoordinatorProposalCard'
import { CoordinatorProposalContext } from '../src/contexts/CoordinatorProposalContext'

test('interactive share proposals use injected confirm, retry and cancel without an owner project', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('owner API must not be used') }
  const initial = { id: 'action', type: 'rerun_from_step', payload: { content: 'Restart' }, status: 'pending' } as any
  let confirms = 0
  let cancels = 0
  let finish!: (value: any) => void
  const actions = {
    canApply: () => true,
    confirm: async (_id: string, key: string) => {
      assert.ok(key)
      confirms++
      if (confirms === 1) return await new Promise<any>(resolve => { finish = resolve })
      return { ...initial, status: 'succeeded' }
    },
    cancel: async () => { cancels++; return { ...initial, status: 'cancelled' } },
    latest: async () => undefined,
  }
  function Harness() {
    const [proposal, setProposal] = useState(initial)
    return <CoordinatorProposalContext.Provider value={actions}>
      <CoordinatorProposalCard proposal={proposal} projectId="" taskId="task" onChanged={setProposal} />
    </CoordinatorProposalContext.Provider>
  }
  const click = async (text: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!
    assert.ok(button)
    await act(async () => button.click())
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness key="confirm" /></I18nProvider>))
    await click('确认')
    assert.ok([...container.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled))
    await click('取消')
    assert.equal(cancels, 0)
    await act(async () => finish({ ...initial, status: 'failed', error: 'retry me' }))
    await click('重试')
    assert.equal(confirms, 2)
    assert.match(container.textContent!, /succeeded/)
    assert.equal(container.querySelectorAll('button').length, 0)
    await act(async () => root.render(<I18nProvider><Harness key="cancel" /></I18nProvider>))
    await click('取消')
    assert.equal(cancels, 1)
    assert.match(container.textContent!, /cancelled/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount()); await window.happyDOM.close()
  }
})

test('read-only coordinator actions show their content and status without mutation buttons', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    for (const status of ['pending', 'failed', 'succeeded']) {
      await act(async () => root.render(<I18nProvider><CoordinatorProposalCard readOnly
        proposal={{ id: 'action', type: 'rerun_from_step', payload: { content: 'Restart frontend' }, status } as any}
        taskId="task" projectId="" onChanged={() => assert.fail('read-only action mutated')} /></I18nProvider>))
      assert.ok(container.textContent?.includes('Restart frontend'))
      assert.ok(container.textContent?.includes(status))
      assert.equal(container.querySelectorAll('button').length, 0)
    }
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
