import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import MarkdownMessage from '../src/components/MarkdownMessage.tsx'
import CodeFilePreview from '../src/components/CodeFilePreview.tsx'
import { fsApi } from '../src/api/client.ts'
import { I18nProvider } from '../src/i18n/index.tsx'
import { classifyProjectFileLink } from '../src/utils/markdownFilePreview.ts'

const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

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

test('resolves file:// absolute links to previewable project files', () => {
  assert.deepEqual(
    classifyProjectFileLink('file:///Users/xzr/Desktop/workstep/demo-preview.html', 'project-1'),
    { path: '/Users/xzr/Desktop/workstep/demo-preview.html', name: 'demo-preview.html' },
  )
  // Windows file URLs keep the drive letter without the URL's leading slash.
  assert.deepEqual(
    classifyProjectFileLink('file:///C:/Users/me/proj/site.html', 'project-1'),
    { path: 'C:/Users/me/proj/site.html', name: 'site.html' },
  )
  // Explicit host form and encoded characters are normalised.
  assert.deepEqual(
    classifyProjectFileLink('file://localhost/Users/me/proj/a%20b.html', 'project-1'),
    { path: '/Users/me/proj/a b.html', name: 'a b.html' },
  )
  // Query / fragment are dropped; trailing slash (a directory) is rejected.
  assert.deepEqual(
    classifyProjectFileLink('file:///Users/me/proj/site.html?open=1#top', 'project-1'),
    { path: '/Users/me/proj/site.html', name: 'site.html' },
  )
  assert.equal(classifyProjectFileLink('file:///Users/me/proj/', 'project-1'), null)
  // Still requires a project context to resolve.
  assert.equal(classifyProjectFileLink('file:///Users/me/proj/site.html', undefined), null)
})

test('splits clickable file line suffixes from Unix and Windows paths', () => {
  assert.deepEqual(
    classifyProjectFileLink('/Users/xzr/Desktop/workstep/app.py:1071', 'project-1'),
    { path: '/Users/xzr/Desktop/workstep/app.py', name: 'app.py', line: 1071 },
  )
  assert.deepEqual(
    classifyProjectFileLink('src/app.ts#L42', 'project-1'),
    { path: 'src/app.ts', name: 'app.ts', line: 42 },
  )
  assert.deepEqual(
    classifyProjectFileLink('C:\\repo\\main.rs:12:5', 'project-1'),
    { path: 'C:\\repo\\main.rs', name: 'main.rs', line: 12, column: 5 },
  )
})

test('renders file:// project links as preview actions', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MarkdownMessage
        content={'[preview](file:///Users/xzr/Desktop/workstep/demo-preview.html) [site](https://example.com)'}
        projectId="project-1"
      />
    </I18nProvider>,
  )

  // Only the file:// link is marked as a preview action; the https link is not.
  assert.match(html, /class="markdown-file-link"/)
  assert.match(html, /data-file-preview="true"/)
  assert.match(html, /href="file:\/\/\/Users\/xzr\/Desktop\/workstep\/demo-preview\.html"/)
  assert.match(html, /href="https:\/\/example\.com"/)
  assert.doesNotMatch(html, /class="markdown-file-link"[^>]*href="https:\/\/example\.com"/)
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

test('marks absolute paths when requesting file preview content', async () => {
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  globalThis.fetch = async (input) => {
    requestedUrl = String(input)
    return new Response(JSON.stringify({
      type: 'text',
      content_type: 'text/markdown',
      content: '# Plan',
      file_size: 6,
      extension: '.md',
      relative_path: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await fsApi.preview('/Users/demo/.claude/plans/example.md', 'project:one')
    assert.equal(
      requestedUrl,
      '/api/fs/preview?path=%2FUsers%2Fdemo%2F.claude%2Fplans%2Fexample.md&project_id=project%3Aone&absolute=true',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
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

test('code preview line numbers cannot be included in text selection', () => {
  assert.match(styles, /\.code-preview-line-number\s*\{[^}]*user-select:\s*none;/s)
  assert.match(styles, /\.code-preview-line-number\s*\{[^}]*-webkit-user-select:\s*none;/s)
})

test('code preview marks the requested source line', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <CodeFilePreview filename="example.ts" content={'one\ntwo\nthree'} line={2} />
    </I18nProvider>,
  )

  assert.match(html, /class="code-preview-line is-target"[^>]*data-line="2"/)
})
