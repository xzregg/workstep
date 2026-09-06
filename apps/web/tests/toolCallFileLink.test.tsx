import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import ToolCallRow from '../src/components/ToolCallRow.tsx'
import ProcessTrace from '../src/components/ProcessTrace.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import type { ToolActivity } from '../src/utils/messageTimeline.ts'

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-1',
    name: 'Read',
    input: { path: 'docs/example.tsx' },
    hasResult: true,
    isError: false,
    ...overrides,
  }
}

function renderRow(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider>{node}</I18nProvider>,
  )
}

test('completed read tool renders a clickable markdown-style file link', () => {
  const html = renderRow(
    <ToolCallRow activity={activity()} projectId="project-1" />,
  )

  assert.match(html, /class="markdown-file-link"/)
  assert.match(html, /data-file-preview="true"/)
  assert.match(html, />example\.tsx</)
  // The summary keeps only the verb — the file name must not repeat there.
  const summary = html.match(/<span class="llm-tool-call-summary[^"]*">([\s\S]*?)<\/span>/)?.[1] ?? ''
  assert.doesNotMatch(summary, /example\.tsx/)
})

test('completed edit tool renders the same file link', () => {
  const html = renderRow(
    <ToolCallRow
      activity={activity({ name: 'EditFile', input: { file_path: 'src/app/main.py' } })}
      projectId="project-1"
    />,
  )

  assert.match(html, /class="markdown-file-link"/)
  assert.match(html, />main\.py</)
})

test('running tool does not render the file link (args may stream partially)', () => {
  const html = renderRow(
    <ToolCallRow
      activity={activity({ hasResult: false })}
      messageRunning
      projectId="project-1"
    />,
  )

  assert.doesNotMatch(html, /markdown-file-link/)
})

test('without a project the target stays plain text', () => {
  const html = renderRow(<ToolCallRow activity={activity()} />)

  assert.doesNotMatch(html, /markdown-file-link/)
  const summary = html.match(/<span class="llm-tool-call-summary[^"]*">([\s\S]*?)<\/span>/)?.[1] ?? ''
  assert.match(summary, /example\.tsx/)
})

test('search tool targets stay plain text even with a project', () => {
  const html = renderRow(
    <ToolCallRow
      activity={activity({ name: 'Grep', input: { pattern: 'docs/example.tsx' } })}
      projectId="project-1"
    />,
  )

  assert.doesNotMatch(html, /markdown-file-link/)
})

test('process trace resolves tool file targets when a project is available', () => {
  const events = [
    {
      type: 'tool_use',
      data: { id: 'tool-1', name: 'Read', input: { path: 'docs/example.tsx' } },
    },
    { type: 'tool_result', data: { tool_use_id: 'tool-1', content: 'file body' } },
  ]

  const withProject = renderRow(
    <ProcessTrace events={events as never} projectId="project-1" />,
  )
  assert.match(withProject, /class="markdown-file-link"/)
  assert.match(withProject, />example\.tsx</)

  const withoutProject = renderRow(<ProcessTrace events={events as never} />)
  assert.doesNotMatch(withoutProject, /markdown-file-link/)
})