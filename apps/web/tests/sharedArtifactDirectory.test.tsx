import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { TaskArtifact } from '../src/api/client.ts'
import TaskArtifactPreviewDialog from '../src/components/TaskArtifactPreviewDialog.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext.tsx'

test('shared artifact directory escapes the content layout and preserves shared file preview', async () => {
  const { window, document } = installDomEnvironment()
  window.innerWidth = 1400
  const directory = {
    path: '/project/.workstep/artifacts/flow/task/step/site',
    name: 'site', is_dir: true,
  } as TaskArtifact
  const file = {
    path: `${directory.path}/backend/2/report.md`, name: 'report.md', is_dir: false,
  } as TaskArtifact
  const host = document.body.appendChild(document.createElement('div'))
  host.style.transform = 'translateX(0)'
  host.style.overflow = 'hidden'
  const root = createRoot(host)
  const loaded: string[] = []
  let closed = false
  try {
    await act(async () => root.render(
      <I18nProvider>
        <MarkdownAssetUrlProvider filePreview={{
          load: async (path) => {
            loaded.push(path)
            return { type: 'text', content_type: 'text/plain', content: 'shared report', file_size: 13, extension: '.txt' }
          },
          rawUrl: (path) => `/share/file?path=${encodeURIComponent(path)}`,
        }}>
          <TaskArtifactPreviewDialog
            artifact={directory}
            directoryFiles={[file, { ...file, path: '/project/private.txt', name: 'private.txt' }]}
            onClose={() => { closed = true }}
          />
        </MarkdownAssetUrlProvider>
      </I18nProvider>,
    ))

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    assert.ok(dialog)
    assert.equal(dialog.parentElement?.parentElement, document.body)
    assert.equal(host.querySelector('[role="dialog"]'), null)
    assert.ok(dialog.querySelector('[role="tree"]'))
    assert.ok(dialog.querySelector('.project-directory-resizer'))
    assert.equal(dialog.querySelectorAll('.project-directory-dialog-resize-handle').length, 8)
    assert.doesNotMatch(dialog.textContent || '', /private\.txt/)
    for (const path of [`${directory.path}/backend`, `${directory.path}/backend/2`]) {
      const folder = dialog.querySelector<HTMLElement>(`[role="treeitem"][title="${path}"]`)
      assert.ok(folder)
      await act(async () => folder.click())
    }
    const fileButton = dialog.querySelector<HTMLElement>(`[role="treeitem"][title="${file.path}"]`)
    assert.ok(fileButton)
    await act(async () => fileButton.click())
    assert.ok(loaded.length > 0)
    assert.ok(loaded.every((path) => path === file.path))
    assert.match(dialog.textContent || '', /shared report/)
    assert.equal(dialog.querySelector('button[aria-label="编辑"]'), null)
    assert.equal(closed, false)
    await act(async () => dialog.parentElement?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })))
    assert.equal(closed, true)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
