import { installDomEnvironment } from './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
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

test('ACP edit kind renders a Codex file change as a previewable file name', () => {
  const html = renderRow(
    <ToolCallRow
      activity={activity({
        name: 'FileChange',
        kind: 'edit',
        input: { path: 'apps/web/src/App.tsx', changes: [{ path: 'apps/web/src/App.tsx' }] },
      })}
      projectId="project-1"
    />,
  )

  assert.match(html, /class="markdown-file-link"/)
  assert.match(html, />App\.tsx</)
})

test('historical Codex FileChange payloads remain previewable', () => {
  const html = renderRow(
    <ToolCallRow
      activity={activity({
        name: 'FileChange',
        input: { changes: [{ path: 'apps/daemon/main.py', diff: '+change' }] },
      })}
      projectId="project-1"
    />,
  )

  assert.match(html, /class="markdown-file-link"/)
  assert.match(html, />main\.py</)
})

test('running tool renders the file link once the path arg is complete', () => {
  const html = renderRow(
    <ToolCallRow
      activity={activity({ hasResult: false })}
      messageRunning
      projectId="project-1"
    />,
  )

  assert.match(html, /class="markdown-file-link"/)
  assert.match(html, />example\.tsx</)
})

test('running tool with a complete JSON string input renders the file link', () => {
  const html = renderRow(
    <ToolCallRow
      activity={activity({
        hasResult: false,
        input: JSON.stringify({ path: 'apps/web/src/main.tsx' }),
      })}
      messageRunning
      projectId="project-1"
    />,
  )

  assert.match(html, /class="markdown-file-link"/)
  assert.match(html, />main\.tsx</)
})

test('running tool with a truncated path renders no file link', () => {
  const html = renderRow(
    <ToolCallRow
      activity={activity({
        hasResult: false,
        input: '{"path":"apps/web/src/mai',
      })}
      messageRunning
      projectId="project-1"
    />,
  )

  assert.doesNotMatch(html, /markdown-file-link/)
})

test('failed read/edit tools render no file link but keep the name in the summary', () => {
  const html = renderRow(
    <ToolCallRow
      activity={activity({ isError: true, result: 'File not found' })}
      projectId="project-1"
    />,
  )

  assert.doesNotMatch(html, /class="markdown-file-link"/)
  assert.match(html, /process-trace-error/)
  const summary = html.match(/<span class="llm-tool-call-summary[^"]*">([\s\S]*?)<\/span>/)?.[1] ?? ''
  assert.match(summary, /example\.tsx/)
})

test('read tool whose input only carries a filter pattern shows a generic file summary', () => {
  const html = renderRow(
    <ToolCallRow
      activity={activity({
        name: 'read_tool_result',
        input: {
          handle: '01a075ae-8b3f-7463-a8ee-cd668e679ff3/call_45bce20d.0',
          offset: 0,
          limit: 200,
          pattern: 'fail',
        },
        result: 'error Command failed with exit code 1.',
        isError: true,
      })}
      projectId="project-1"
    />,
  )

  // The filter keyword must not surface as a file name, neither as a link
  // nor inside the summary text.
  assert.doesNotMatch(html, /class="markdown-file-link"/)
  assert.doesNotMatch(html, />fail</)
  const summary = html.match(/<span class="llm-tool-call-summary[^"]*">([\s\S]*?)<\/span>/)?.[1] ?? ''
  assert.doesNotMatch(summary, /fail/)
  assert.match(html, /process-trace-error/)
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

test('process trace reveals tool file links after expanding the timeline', async () => {
  const events = [
    {
      type: 'tool_use',
      data: { id: 'tool-1', name: 'Read', input: { path: 'docs/example.tsx' } },
    },
    { type: 'tool_result', data: { tool_use_id: 'tool-1', content: 'file body' } },
  ]

  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(
      <I18nProvider><ProcessTrace events={events as never} projectId="project-1" running /></I18nProvider>,
    ))
    assert.doesNotMatch(container.innerHTML, /markdown-file-link/)
    assert.equal(container.querySelector('.process-trace-session-summary')?.getAttribute('aria-expanded'), 'false')

    await act(async () => {
      (container.querySelector('.process-trace-session-summary') as HTMLElement).click()
    })
    assert.match(container.innerHTML, /class="markdown-file-link"/)
    assert.match(container.innerHTML, />example\.tsx</)

    await act(async () => root.render(
      <I18nProvider><ProcessTrace events={events as never} running /></I18nProvider>,
    ))
    assert.doesNotMatch(container.innerHTML, /markdown-file-link/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
