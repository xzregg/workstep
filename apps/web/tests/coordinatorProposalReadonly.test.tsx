import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { CoordinatorProposalCard } from '../src/components/CoordinatorProposalCard'

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
