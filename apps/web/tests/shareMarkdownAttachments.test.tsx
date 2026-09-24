import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import MarkdownMessage from '../src/components/MarkdownMessage.tsx'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

const resolveShareUpload = (src: string) => {
  const match = src.match(/^\.workstep\/uploads\/([^/?#]+)$/)
  return match
    ? `/api/task-share/public/share-token/uploads/${match[1]}?session=share-session`
    : src
}

function render(content: string) {
  return renderToStaticMarkup(
    <I18nProvider>
      <MarkdownAssetUrlProvider resolver={resolveShareUpload}>
        <MarkdownMessage content={content} plainText />
      </MarkdownAssetUrlProvider>
    </I18nProvider>,
  )
}

test('share task messages resolve uploaded images through the share session', () => {
  const html = render('截图 ![image.png](.workstep/uploads/task-image.png)')

  assert.match(
    html,
    /src="\/api\/task-share\/public\/share-token\/uploads\/task-image\.png\?session=share-session"/,
  )
})

test('share task messages resolve uploaded file links without changing external links', () => {
  const html = render(
    '[附件](.workstep/uploads/task-report.pdf) [官网](https://example.com)',
  )

  assert.match(
    html,
    /href="\/api\/task-share\/public\/share-token\/uploads\/task-report\.pdf\?session=share-session"/,
  )
  assert.match(html, /href="https:\/\/example\.com"/)
})

test('shared project file links become preview actions', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MarkdownAssetUrlProvider filePreview={{
        load: async () => { throw new Error('unused') },
        rawUrl: (path) => `/shared/${path}`,
      }}>
        <MarkdownMessage content="[报告](report.md) [网站](https://example.com)" />
      </MarkdownAssetUrlProvider>
    </I18nProvider>,
  )

  assert.match(html, /href="report\.md"[^>]*data-file-preview="true"/)
  assert.match(html, /href="https:\/\/example\.com"[^>]*target="_blank"/)
})
