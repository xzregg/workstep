import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskArtifact } from '../src/api/client.ts'
import TaskArtifactPreviewDialog from '../src/components/TaskArtifactPreviewDialog.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

test('shared artifact directory lists its files for preview', () => {
  const directory = {
    path: '/project/.workstep/artifacts/flow/task/step/site',
    name: 'site', is_dir: true,
  } as TaskArtifact
  const file = {
    path: `${directory.path}/index.html`, name: 'index.html', is_dir: false,
  } as TaskArtifact
  const html = renderToStaticMarkup(
    <I18nProvider>
      <TaskArtifactPreviewDialog
        artifact={directory}
        directoryFiles={[file]}
        onClose={() => {}}
      />
    </I18nProvider>,
  )

  assert.match(html, /index\.html/)
  assert.match(html, /role="dialog"/)
})
