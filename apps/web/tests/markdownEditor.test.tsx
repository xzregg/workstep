import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import MarkdownEditor from '../src/components/MarkdownEditor.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

test('renders the compact attachment and preview affordances without a toolbar row', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MarkdownEditor
        value="任务说明"
        onChange={() => {}}
        projectId="project-1"
        showAttachmentHint
      />
    </I18nProvider>,
  )

  assert.match(html, /class="markdown-editor-shell"/)
  assert.match(html, /可粘贴或拖入附件/)
  assert.match(html, /aria-label="上传附件"/)
  assert.match(html, /aria-label="预览 Markdown"/)
  assert.match(html, /type="file"/)
  assert.doesNotMatch(html, /accept="image\/\*"/)
  assert.doesNotMatch(html, />编辑</)
})
