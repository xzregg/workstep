import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import MarkdownMessage from '../src/components/MarkdownMessage.tsx'
import CodeFilePreview from '../src/components/CodeFilePreview.tsx'
import { fsApi } from '../src/api/client.ts'
import { I18nProvider } from '../src/i18n/index.tsx'
import { classifyProjectFileLink } from '../src/utils/markdownFilePreview.ts'

test('classifies project files without intercepting external links', () => {
  assert.deepEqual(classifyProjectFileLink('docs/example.tsx', 'project-1'), {
    path: 'docs/example.tsx',
    name: 'example.tsx',
  })
  assert.deepEqual(classifyProjectFileLink('.workstep/uploads/report.pdf', 'project-1'), {
    path: '.workstep/uploads/report.pdf',
    name: 'report.pdf',
  })
  assert.equal(classifyProjectFileLink('https://example.com/file.ts', 'project-1'), null)
  assert.equal(classifyProjectFileLink('#section', 'project-1'), null)
  assert.equal(classifyProjectFileLink('mailto:dev@example.com', 'project-1'), null)
  assert.equal(classifyProjectFileLink('docs/example.tsx', undefined), null)
})

test('shared markdown marks project file links as preview actions', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MarkdownMessage
        content={'[example.tsx](docs/example.tsx) [website](https://example.com)'}
        projectId="project-1"
      />
    </I18nProvider>,
  )

  assert.match(html, /class="markdown-file-link"/)
  assert.match(html, /data-file-preview="true"/)
  assert.match(html, /href="docs\/example\.tsx"/)
  assert.doesNotMatch(html, /data-file-preview="true"[^>]*href="https:\/\/example\.com"/)
})

test('project raw URLs retain project scope and file hierarchy', () => {
  assert.equal(
    fsApi.projectFileUrl('docs/site/index.html', 'project:one'),
    '/api/fs/project-raw/project%3Aone/docs/site/index.html?project_id=project%3Aone',
  )
  assert.equal(
    fsApi.projectFileUrl('/Users/demo/My Site/index.html', 'project:one'),
    '/api/fs/project-raw/project%3Aone/Users/demo/My%20Site/index.html?project_id=project%3Aone&absolute=true',
  )
})

test('code preview renders line numbers, language metadata and highlighted tokens', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <CodeFilePreview filename="example.ts" content={'const answer: number = 42\nconsole.log(answer)'} />
    </I18nProvider>,
  )

  assert.match(html, /data-language="typescript"/)
  assert.match(html, /class="code-preview-line-number"[^>]*>1</)
  assert.match(html, /class="code-preview-line-number"[^>]*>2</)
  assert.match(html, /hljs-keyword/)
  assert.match(html, /const/)
})
