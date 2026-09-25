import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import TaskArtifactPreviewDialog from '../src/components/TaskArtifactPreviewDialog.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

const artifact = {
  name: 'comparison=方案对照.html',
  path: '/project/.workstep/artifacts/task/intake/1/comparison=方案对照.html',
  is_dir: false,
} as any

for (const hostname of ['192.168.1.20', '127.0.0.1']) {
  test(`artifact preview opens the appropriate directory on ${hostname}`, async () => {
    const { window, document } = installDomEnvironment()
    window.location.href = `http://${hostname}/tasks`
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => Response.json({ entries: [], path: '/project/.workstep/artifacts/task/intake/1' })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    let nativeOpenCount = 0

    try {
      await act(async () => root.render(
        <I18nProvider>
          <TaskArtifactPreviewDialog
            artifact={artifact}
            projectId="project-one"
            onClose={() => {}}
            onOpenDirectory={() => { nativeOpenCount += 1 }}
            canOpenDirectory
          />
        </I18nProvider>,
      ))
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((element) => /打开所在目录|Open containing folder/.test(element.textContent || ''))
      assert.ok(button)
      await act(async () => button.click())

      if (hostname === '127.0.0.1') {
        assert.equal(nativeOpenCount, 1)
        assert.equal(document.querySelector('.project-directory-dialog'), null)
      } else {
        assert.equal(nativeOpenCount, 0)
        assert.equal(
          document.querySelector('.project-directory-dialog-heading span')?.getAttribute('title'),
          '/project/.workstep/artifacts/task/intake/1',
        )
      }
    } finally {
      await act(async () => root.unmount())
      globalThis.fetch = originalFetch
      await window.happyDOM.close()
    }
  })
}
