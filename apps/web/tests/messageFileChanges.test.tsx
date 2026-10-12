import { installDomEnvironment } from './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProcessTrace from '../src/components/ProcessTrace'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import { I18nProvider } from '../src/i18n'
import { buildMessageTimeline } from '../src/utils/messageTimeline'
import { collectMessageFileChanges, relativeMessageFilePath } from '../src/utils/messageFileChanges'
import { useProjectStore } from '../src/stores/projectStore'
import MessageFileChanges from '../src/components/MessageFileChanges'

const patch = '@@ -4,2 +4,3 @@\n-old\n+new\n+extra\n context\n'
function edit(id: string, args: unknown, overrides: Record<string, unknown> = {}) {
  return [
    { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'FileChange', kind: 'edit' },
    { type: 'TOOL_CALL_ARGS', toolCallId: id, args },
    { type: 'TOOL_CALL_RESULT', toolCallId: id, output: 'done', ...overrides },
  ]
}
const events = [
  ...edit('one', { changes: [{ path: './src/main.ts', diff: patch }, { path: 'docs/a.md' }] }),
  ...edit('two', JSON.stringify({ path: 'src/main.ts', diff: '@@ -8 +8 @@\n-before\n+after\n' })),
]

test('edited files are grouped by relative directory and sorted by filename within each directory', async () => {
  const { window } = installDomEnvironment()
  const previous = useProjectStore.getState()
  useProjectStore.setState({ projects: [{ id: 'p', path: '/project', name: 'demo', steps: {}, workflows: [] }] })
  const paths = ['apps/web/Z.ts', '/project/apps/daemon/api/fs.py', 'apps/web/a10.ts',
    'docs/code-map.md', './apps/web/a2.ts', 'apps/daemon/main.py', 'README.md']
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MessageFileChanges projectId="p"
      events={edit('files', { changes: paths.map(path => ({ path })) })} /></I18nProvider>))
    await act(async () => (container.querySelector('.message-file-changes-toggle') as HTMLElement).click())
    assert.deepEqual([...container.querySelectorAll('.message-file-change-path')].map(node => node.textContent), [
      'README.md', 'apps/daemon/main.py', 'apps/daemon/api/fs.py',
      'apps/web/a2.ts', 'apps/web/a10.ts', 'apps/web/Z.ts', 'docs/code-map.md',
    ])
    assert.deepEqual(paths, ['apps/web/Z.ts', '/project/apps/daemon/api/fs.py', 'apps/web/a10.ts',
      'docs/code-map.md', './apps/web/a2.ts', 'apps/daemon/main.py', 'README.md'])
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState({ projects: previous.projects })
    await window.happyDOM.close()
  }
})

test('edited file rows expose a context menu, copy the project path, and dismiss with Escape', async () => {
  const { window } = installDomEnvironment()
  const previous = useProjectStore.getState()
  useProjectStore.setState({ projects: [{ id: 'p', path: '/project', name: 'demo', steps: {}, workflows: [] }] })
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MessageFileChanges events={events} projectId="p" /></I18nProvider>))
    await act(async () => (container.querySelector('.message-file-changes-toggle') as HTMLElement).click())
    const row = [...container.querySelectorAll('.message-file-change-row')].find(node => node.textContent?.includes('src/main.ts'))!
    const open = () => row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }))
    await act(async () => { open() })
    assert.ok(document.querySelector('[role="menu"]'))
    assert.equal(document.querySelector('.git-diff-dialog'), null)
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent === '复制路径') as HTMLElement
    assert.ok(item)
    await act(async () => item.click())
    assert.deepEqual(copied, ['/project/src/main.ts'])
    await act(async () => { open() })
    await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(document.querySelector('[role="menu"]'), null)
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState({ projects: previous.projects })
    await window.happyDOM.close()
  }
})

test('file labels are relative to the project root with directory boundaries and Windows support', () => {
  assert.equal(relativeMessageFilePath('/Users/me/workstep/apps/web/src/App.tsx', '/Users/me/workstep/'), 'apps/web/src/App.tsx')
  assert.equal(relativeMessageFilePath('./src/App.tsx', '/Users/me/workstep'), 'src/App.tsx')
  assert.equal(relativeMessageFilePath('/Users/me/workstep-other/App.tsx', '/Users/me/workstep'), '../workstep-other/App.tsx')
  assert.equal(relativeMessageFilePath('C:\\Projects\\WorkStep\\src\\App.tsx', 'c:\\projects\\workstep\\'), 'src/App.tsx')
})

test('relative and absolute edits of the same project file are merged without changing the preview path', () => {
  const events = [...edit('absolute', { path: '/project/src/main.ts', diff: patch }),
    ...edit('relative', { path: 'src/main.ts', diff: patch })]
  const files = collectMessageFileChanges(buildMessageTimeline(events), events, '/project')
  assert.equal(files.length, 1)
  assert.equal(files[0].path, '/project/src/main.ts')
  assert.equal(files[0].added, 4)
})

test('file labels use the message project instead of the active project and preview keeps the source path', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(globalThis, 'history', { configurable: true, value: window.history })
  const previous = useProjectStore.getState()
  useProjectStore.setState({ projects: [{ id: 'project-1', path: '/Users/me/workstep', name: 'demo', steps: {}, workflows: [] }],
    activeProject: { id: 'other', path: '/other', name: 'other', steps: {}, workflows: [] } })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ChatMessageBubble role="assistant" sender="助手"
      initials="AI" color="var(--accent)" content="已完成" projectId="project-1"
      events={edit('absolute', { path: '/Users/me/workstep/apps/web/src/App.tsx', diff: patch })} /></I18nProvider>))
    await act(async () => (container.querySelector('.message-file-changes-toggle') as HTMLElement).click())
    const button = container.querySelector('.message-file-change-path') as HTMLElement
    assert.equal(button.textContent, 'apps/web/src/App.tsx')
    assert.equal(button.title, 'apps/web/src/App.tsx')
    await act(async () => button.click())
    assert.equal(document.querySelector('.git-diff-dialog header strong')?.textContent, '/Users/me/workstep/apps/web/src/App.tsx')
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState({ projects: previous.projects, activeProject: previous.activeProject })
    await window.happyDOM.close()
  }
})

test('all edited files are deduplicated and patch counts exclude diff headers', () => {
  const files = collectMessageFileChanges(buildMessageTimeline(events), events)
  assert.deepEqual(files.map(({ path, added, removed }) => ({ path, added, removed })), [
    { path: 'src/main.ts', added: 3, removed: 2 },
    { path: 'docs/a.md', added: null, removed: null },
  ])
  assert.match(files[0].patch!, /old[\s\S]*before/)
})

test('header-like source lines in hunks are counted, and unknown edits suppress incomplete totals', () => {
  const events = [
    ...edit('headers', { path: 'headers.ts', diff: '--- a/headers.ts\n+++ b/headers.ts\n@@ -1 +1 @@\n--- old\n+++ new\n' }),
    ...edit('known', { path: 'mixed.ts', diff: patch }),
    ...edit('unknown', { path: 'mixed.ts' }),
  ]
  const files = collectMessageFileChanges(buildMessageTimeline(events), events)
  assert.equal(files[0].added, 1)
  assert.equal(files[0].removed, 1)
  assert.equal(files[1].added, null)
  assert.equal(files[1].removed, null)
  assert.equal(files[1].patch, undefined)
})

test('reads, failed edits and unfinished edits never enter the changed file list', () => {
  const events = [
    ...edit('failed', { path: 'failed.ts' }, { isError: true }),
    { type: 'TOOL_CALL_START', toolCallId: 'pending', toolCallName: 'Edit' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'pending', args: { path: 'pending.ts' } },
    { type: 'tool_use', data: { id: 'read', name: 'Read', input: { path: 'read.ts' } } },
    { type: 'tool_result', data: { tool_use_id: 'read', content: 'text' } },
  ]
  assert.deepEqual(collectMessageFileChanges(buildMessageTimeline(events), events), [])
})

test('ACP diff content and legacy edit parameters provide file counts', () => {
  const events = [
    ...edit('acp', {}, { content: [{ type: 'diff', path: 'acp.ts', oldText: 'old\n', newText: 'new\nextra\n' }] }),
    { type: 'tool_use', data: { id: 'legacy', name: 'Edit', input: { file_path: 'legacy.ts', old_string: 'old', new_string: 'new' } } },
    { type: 'tool_result', data: { tool_use_id: 'legacy', content: 'done' } },
  ]
  assert.deepEqual(collectMessageFileChanges(buildMessageTimeline(events), events).map(({ path, added, removed }) => ({ path, added, removed })), [
    { path: 'acp.ts', added: 2, removed: 1 },
    { path: 'legacy.ts', added: 1, removed: 1 },
  ])
})

test('apply_patch includes all file operations and counts only changed lines', () => {
  const events = edit('patch', { patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+first\n+second\n*** Delete File: src/c.ts\n*** End Patch' })
  events[0].toolCallName = 'apply_patch'
  assert.deepEqual(collectMessageFileChanges(buildMessageTimeline(events), events).map(({ path, added, removed }) => ({ path, added, removed })), [
    { path: 'src/a.ts', added: 1, removed: 1 },
    { path: 'src/b.ts', added: 2, removed: 0 },
    { path: 'src/c.ts', added: null, removed: null },
  ])
})

test('completed messages place a collapsed file summary below the body and preview read-only changes', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(globalThis, 'history', { configurable: true, value: window.history })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let loads = 0
  const render = (running: boolean, detailsAvailable = false, detailsLoaded = false) => root.render(
    <I18nProvider><ChatMessageBubble role="assistant" sender="助手" initials="AI" color="var(--accent)"
      content="完成修改的正文" events={events} streaming={running} projectId="project-1"
      eventDetail={{ available: detailsAvailable, loaded: detailsLoaded }} onLoadEventDetails={() => { loads++ }}
      header={<ProcessTrace events={events} running={running} />} /></I18nProvider>,
  )
  const expand = () => (container.querySelector('.process-trace-session-summary') as HTMLElement).click()
  try {
    await act(async () => render(true))
    await act(async () => expand())
    assert.equal(container.querySelector('.message-file-changes'), null)
    await act(async () => render(false, true, false))
    await act(async () => expand())
    assert.equal(container.querySelector('.process-trace-body .message-file-changes'), null)
    assert.equal(container.querySelectorAll('.message-file-change-row').length, 0)
    await act(async () => (container.querySelector('.message-file-changes-toggle') as HTMLElement).click())
    assert.equal(loads, 1)
    await act(async () => render(false, true, true))
    assert.match(container.querySelector('.message-file-changes')!.textContent!, /已编辑 2 个文件/)
    assert.ok(container.querySelector('.message-file-changes-header .message-file-changes-toggle'))
    const body = container.querySelector('.chat-bubble')!
    const card = container.querySelector('.message-file-changes')!
    assert.equal(body.parentElement, card.parentElement)
    assert.ok(body.compareDocumentPosition(card) & window.Node.DOCUMENT_POSITION_FOLLOWING)
    assert.equal(container.querySelectorAll('.message-file-change-row').length, 2)
    assert.match(container.querySelector('.message-file-changes')!.textContent!, /\+3.*-2/)
    await act(async () => (container.querySelector('.message-file-changes-toggle') as HTMLElement).click())
    assert.equal(container.querySelectorAll('.message-file-change-row').length, 0)
    await act(async () => (container.querySelector('.message-file-changes-toggle') as HTMLElement).click())
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('recorded changes must not fetch the current workspace') }) as typeof fetch
    try {
      await act(async () => ([...container.querySelectorAll<HTMLElement>('.message-file-change-path')].find(node => node.textContent === 'src/main.ts')!).click())
      const dialog = document.querySelector('.git-diff-dialog')!
      assert.ok(dialog)
      assert.match(dialog.textContent!, /old.*new.*before.*after/s)
      assert.equal(dialog.querySelector('.git-error'), null)
      assert.equal(dialog.querySelector('.git-copy-block'), null)
      assert.doesNotMatch(dialog.textContent!, /撤销|重新应用|编辑文件/)
    } finally { globalThis.fetch = originalFetch }
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('a fresh completed message defaults to a collapsed file summary', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ChatMessageBubble role="assistant"
      sender="助手" initials="AI" color="var(--accent)" content="已完成" events={events} /></I18nProvider>))
    assert.match(container.querySelector('.message-file-changes')!.textContent!, /已编辑 2 个文件/)
    assert.equal(container.querySelector('.message-file-changes-toggle')?.getAttribute('aria-expanded'), 'false')
    assert.equal(container.querySelectorAll('.message-file-change-row').length, 0)
    await act(async () => (container.querySelector('.message-file-changes-toggle') as HTMLElement).click())
    assert.equal(container.querySelectorAll('.message-file-change-row').length, 2)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('messages without confirmed edits have no file card and never load details automatically', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let loads = 0
  try {
    for (const edited_files of [undefined, []]) {
      await act(async () => root.render(<I18nProvider><ChatMessageBubble role="assistant"
        sender="助手" initials="AI" color="var(--accent)" content="只读检查已完成" events={[]}
        eventDetail={{ available: true, loaded: false, edited_files }}
        onLoadEventDetails={() => { loads++ }} /></I18nProvider>))
      assert.equal(container.querySelector('.message-file-changes'), null)
    }
    assert.equal(loads, 0)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('historical edit summaries show the actual file count before any detail request', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let loads = 0
  try {
    await act(async () => root.render(<I18nProvider><ChatMessageBubble role="assistant"
      sender="助手" initials="AI" color="var(--accent)" content="已修改" events={[]}
      eventDetail={{ available: true, loaded: false, edited_files: ['src/a.ts', 'src/b.ts'] }}
      onLoadEventDetails={() => { loads++ }} /></I18nProvider>))
    assert.match(container.querySelector('.message-file-changes')!.textContent!, /已编辑 2 个文件/)
    assert.equal(loads, 0)
    assert.equal(container.querySelectorAll('.message-file-change-row').length, 0)
    await act(async () => (container.querySelector('.message-file-changes-toggle') as HTMLElement).click())
    assert.equal(loads, 1)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
