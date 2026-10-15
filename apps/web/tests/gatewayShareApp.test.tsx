import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'

for (const { interactive, standalone } of [
  { interactive: false, standalone: false }, { interactive: true, standalone: false },
  { interactive: false, standalone: true },
]) test(`Gateway public route mounts scoped ${standalone ? 'standalone file preview' : interactive ? 'interactive' : 'read-only'} access`, async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://localhost:8700/share/handle' + (standalone
    ? '?preview=1&path=.workstep%2Fartifacts%2Fflow%2Ftask%2Fbuild%2Freq1%2Fnew.md&name=new.md' : ''))
  document.head.innerHTML = '<meta name="workstep-share-transport" content="gateway">'
  useLocaleStore.setState({ locale: 'zh-CN' })
  const previousOpenMode = useUserSettingsStore.getState().openMode
  useUserSettingsStore.setState({ openMode: true })
  const originalFetch = globalThis.fetch
  const originalSocket = globalThis.WebSocket
  const originalTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let poll: (() => void) | undefined
  let shareSocket: any
  globalThis.setTimeout = ((callback: () => void, ms: number, ...args: any[]) => {
    if (ms === 2000 || ms === 30000) { poll = callback; return 98765 }
    return originalTimeout(callback, ms, ...args)
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: any) => { if (id === 98765) poll = undefined; else originalClearTimeout(id) }) as typeof clearTimeout
  const calls: string[] = []
  const operations: Array<{ path: string; method: string; body?: any; idempotency_key?: string }> = []
  let openedUrl = ''
  let sharedDescription = 'Original task description'
  window.open = ((url: string | URL) => { openedUrl = String(url); return null }) as typeof window.open
  const sourcePath = 'flow/task/build/req1/new.md'
  const recordedPath = `/data/private/project/.workstep/artifacts/${sourcePath}`
  const artifactId = 'a'.repeat(64)
  const directoryId = 'b'.repeat(64)
  const proposal = { id: 'proposal-1', type: 'rerun_from_step', status: 'pending', payload: { content: 'Restart build' }, target_step_key: 'build' }
  Object.assign(globalThis, { ResizeObserver: window.ResizeObserver,
    WebSocket: class {
      onopen?: () => void
      onmessage?: (event: { data: string }) => void
      constructor(url: string) {
        assert.equal(url, 'ws://localhost:8700/ws/public/shares/handle')
        shareSocket = this
      }
      close() {}
    } })
  globalThis.fetch = async (input, init) => {
    const path = String(input); calls.push(path)
    const prefix = '/api/public/shares/handle'
    if (path === prefix + '/operation') {
      assert.equal(new Headers(init?.headers).get('X-Share-CSRF'), 'restored-csrf')
      const operation = JSON.parse(String(init?.body))
      operations.push(operation)
      const target = new URL(operation.path, 'http://localhost').pathname
      if (target === '/task/task/coordinator-config') return Response.json({
        configured: { engine: '', model: '', fast_model: '', vision_model: '', thinking_effort: '', provider_id: '' },
        resolved: { engine: 'codex', model: 'gpt-test', fast_model: '', vision_model: '', thinking_effort: '', provider_id: '' },
        available_engines: [],
      })
      if (target === '/fs/preview') {
        assert.match(operation.path, /artifacts/); return Response.json({ type: 'text', content: 'New shared document', extension: '.md', content_type: 'text/markdown', file_size: 20 })
      }
      if (target === '/fs/browse') {
        const current = new URL(operation.path, 'http://localhost').searchParams.get('path')!.replace(/\/$/, '')
        const file = '.workstep/artifacts/' + sourcePath
        const parts = file.slice(current.length + 1).split('/')
        const child = current + '/' + parts[0]
        return Response.json({ path: current, name: current.split('/').pop(), parent: null,
          entries: [{ path: child, name: parts[0], type: parts.length > 1 ? 'directory' : 'file', relative_path: child }] })
      }
      if (target === '/provider/list') return Response.json({ providers: [], types: [] })
      if (target === '/tasks/task/actions') return Response.json({ buttons: [], runs: [] })
      if (target === '/task/task/discussion-groups') return Response.json([])
      if (target === '/task/task/actions/proposal-1/confirm') {
        assert.ok(operation.idempotency_key)
        proposal.status = 'succeeded'
        return Response.json(proposal)
      }
      if (target === '/task/task/steps/build/review/approve') return Response.json({ resumed: true })
      if (target === '/intervention/respond') return Response.json({ delivered: true })
      if (target === '/task/task/reviews') return globalThis.fetch(prefix + '/reviews')
      if (target === '/task/task/history') return globalThis.fetch(prefix + '/history')
      if (target === '/task/task') {
        if (operation.method === 'PATCH') sharedDescription = operation.body.description
        return globalThis.fetch(prefix + '/task')
      }
      if (target === '/task/list') return Response.json({ tasks: [(await (await globalThis.fetch(prefix + '/task')).json())] })
      throw new Error(`Unmapped task operation: ${target}`)
    }
    if (path === prefix + '/meta') return Response.json({ title: 'Shared', mode: interactive ? 'interactive' : 'read_only', has_password: false })
    if (path === prefix + '/session') return Response.json({ csrf_token: 'restored-csrf' })
    if (path === prefix + '/unlock') return Response.json({ csrf_token: 'csrf' })
    if (path === prefix + '/task') return Response.json({ id: 'task', title: 'Gateway task', description: sharedDescription, status: interactive ? 'awaiting_review' : 'pending',
      created_at: '2026-10-03T00:00:00Z', steps: [{ step_key: 'build', status: interactive ? 'awaiting_review' : 'pending', has_history: false }], workflow: null })
    if (path === prefix + '/history') return Response.json({ messages: [{ id: 'message', role: 'assistant',
      step_key: 'build', content: 'Visible execution', prompt: 'Shared actual input', created_at: '2026-10-03T00:00:00Z', events: [
        { type: 'TOOL_CALL_START', toolCallId: 'new-file', toolCallName: 'Write', kind: 'edit' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'new-file', args: { path: recordedPath } },
        { type: 'TOOL_CALL_RESULT', toolCallId: 'new-file', output: 'done' },
      ] }, { id: 'coordinator-message', role: 'assistant', channel: 'coordinator', content: 'Proposed action', proposals: [proposal] }], next_offset: null, interventions: interactive ? [{ interaction_id: 'permission', step_key: 'build', request: { method: 'session/request_permission', tool_call: { title: 'Review command' }, options: [{ option_id: 'once', name: '允许本次操作', kind: 'allow_once' }] } }] : [] })
    if (path === prefix + '/actions/proposal-1/confirm') {
      assert.equal(new Headers(init?.headers).get('X-Share-CSRF'), 'restored-csrf')
      assert.ok(JSON.parse(String(init?.body)).idempotency_key)
      proposal.status = 'succeeded'
      return Response.json(proposal)
    }
    if (path === prefix + '/artifacts') return Response.json({ artifacts: [
      { id: artifactId, source_path: sourcePath, name: 'new.md', relative_path: 'new.md', step_key: 'build' },
      { id: directoryId, source_path: 'flow/task/build/req1/code', name: 'code', relative_path: 'code', step_key: 'build', is_dir: true },
    ] })
    if (path.startsWith(prefix + '/git/read/')) {
      const [, action, encoded] = path.slice((prefix + '/git/read/').length).match(/^([^/]+)\/(.+)$/)!
      const { path: virtual } = JSON.parse(Buffer.from(encoded, 'hex').toString())
      assert.ok(virtual.startsWith(`artifact:${directoryId}`))
      if (action === 'browse') return Response.json({ path: virtual, name: 'code', parent: null,
        entries: [{ name: 'main.py', type: 'file', path: virtual + '/main.py', relative_path: virtual + '/main.py' }] })
      return Response.json({ type: 'text', content: 'print("share test")', extension: '.py', content_type: 'text/plain', file_size: 20 })
    }
    if (path === prefix + `/artifacts/${artifactId}/preview`) return Response.json({ type: 'text', content: 'New shared document', extension: '.md', content_type: 'text/markdown', file_size: 20 })
    if (path === prefix + '/reviews') return Response.json({ reviews: interactive ? [{ id: 'review', step_key: 'build', mode: 'manual', status: 'pending', report: null }] : [] })
    if (path === prefix + '/steps/build/review/approve') {
      assert.equal(new Headers(init?.headers).get('X-Share-CSRF'), 'restored-csrf')
      assert.deepEqual(JSON.parse(String(init?.body)), { review_run_id: 'review' })
      return Response.json({ resumed: true })
    }
    if (path === prefix + '/interventions/permission/respond') {
      assert.equal(new Headers(init?.headers).get('X-Share-CSRF'), 'restored-csrf')
      assert.deepEqual(JSON.parse(String(init?.body)), { data: { outcome: { outcome: 'selected', option_id: 'once' } } })
      return Response.json({ delivered: true })
    }
    throw new Error(`Unscoped API: ${path}`)
  }
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><App /></I18nProvider>))
    if (standalone) {
      assert.ok(element.querySelector('.standalone-preview-page'))
      assert.ok(element.querySelector('.artifact-markdown-preview'))
      assert.match(element.textContent!, /New shared document/)
      assert.equal(element.querySelector('.task-detail-header'), null)
    assert.ok(calls.every(path => path.startsWith('/api/public/shares/handle/')), JSON.stringify(calls.filter(path => !path.startsWith('/api/public/shares/handle/'))))
      assert.equal(calls.filter(path => path.endsWith(`/artifacts/${artifactId}/preview`)).length, 1)
      return
    }
    assert.ok(element.querySelector('.task-detail-header'))
    assert.ok(shareSocket, 'gateway shares must connect their task-scoped websocket')
    await act(async () => shareSocket.onopen())
    assert.equal(poll, undefined, 'a connected share must not schedule snapshot polling')
    assert.ok(element.textContent?.includes('Gateway task'))
    assert.ok(element.textContent?.includes('Visible execution'))
    assert.equal(element.querySelector('.app-shell'), null)
    await act(async () => (element.querySelector('.chat-message-action--prompt') as HTMLElement).click())
    const promptDialog = document.querySelector('[role="dialog"][aria-label="完整提示词"]')!
    assert.ok(promptDialog)
    assert.match(promptDialog.textContent!, /Shared actual input/)
    await act(async () => (promptDialog.querySelector('button[aria-label="关闭提示词"]') as HTMLElement).click())
    await act(async () => (element.querySelector('.message-file-changes-toggle') as HTMLElement).click())
    await act(async () => (element.querySelector('button.message-file-change-path') as HTMLElement).click())
    assert.match(document.querySelector('.file-preview-dialog')!.textContent!, /New shared document/)
    assert.equal(calls.filter(path => path.endsWith(`/artifacts/${artifactId}/preview`)).length, 1)
    await act(async () => shareSocket.onmessage({ data: JSON.stringify({ type: 'CUSTOM', name: 'workstep.task_updated', task_id: 'task' }) }))
    assert.equal(calls.filter(path => path.endsWith(`/artifacts/${artifactId}/preview`)).length, 1,
      'refreshing shared task snapshots must not restart an open file preview')
    assert.match(document.querySelector('.file-preview-dialog')!.textContent!, /New shared document/)
    await act(async () => (document.querySelector('.file-preview-dialog-close') as HTMLElement).click())
    const artifactsTab = [...element.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find(tab => tab.textContent?.trim() === '产物')!
    await act(async () => artifactsTab.click())
    const output = element.querySelector('.task-artifact-file-row') as HTMLElement
    assert.ok(output)
    await act(async () => output.click())
    await act(async () => (document.querySelector('.task-artifact-preview-dialog .artifact-open-window-button') as HTMLElement).click())
    const opened = new URL(openedUrl, window.location.origin)
    assert.equal(opened.pathname, '/share/handle')
    assert.equal(opened.searchParams.get('preview'), '1')
    assert.equal(opened.searchParams.get('path'), '.workstep/artifacts/flow/task/build/req1/new.md')
    const containingDirectory = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '打开所在目录')
    assert.ok(containingDirectory, 'share artifact preview provides the same directory action')
    await act(async () => containingDirectory.click())
    const directory = document.querySelector('.project-directory-dialog')!
    assert.ok(directory)
    assert.match(directory.textContent!, /new\.md/)
    assert.equal(directory.querySelector('button[aria-label="编辑"]'), null)
    const sharedFile = directory.querySelector('[role="treeitem"][title$="/new.md"]') as HTMLElement
    assert.ok(sharedFile)
    await act(async () => sharedFile.click())
    assert.match(directory.textContent!, /New shared document/)
    await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('.task-artifact-preview-header button')]
      .find(button => button.textContent === '✕')!).click())
    await act(async () => (element.querySelector('.task-artifact-toolbar button') as HTMLElement).click())
    assert.ok(document.querySelector('[role="treeitem"][title=".workstep/artifacts/flow/task/build"]'))
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => (element.querySelector('.task-artifact-open-directory--step') as HTMLElement).click())
    assert.equal(document.querySelector('.project-directory-dialog-heading span')?.getAttribute('title'), '.workstep/artifacts/flow/task/build')
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    const directoryOutput = [...element.querySelectorAll<HTMLElement>('.task-artifact-file-row')]
      .find(row => row.textContent?.includes('code'))!
    assert.ok(directoryOutput)
    await act(async () => directoryOutput.click())
    const directoryPreview = document.querySelector('.project-directory-dialog')!
    assert.ok(directoryPreview, 'both share modes must browse directory artifacts')
    const codeFile = directoryPreview.querySelector<HTMLElement>('[role="treeitem"][title$="/main.py"]')!
    assert.ok(codeFile)
    await act(async () => codeFile.click())
    assert.match(directoryPreview.textContent!, /share test/)
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    const detailTab = element.querySelector<HTMLButtonElement>('.task-detail-primary-tabs [role="tab"]')!
    await act(async () => detailTab.click())
    if (!interactive) assert.equal(element.querySelector('.chat-input'), null)
    else {
      await act(async () => element.querySelector<HTMLButtonElement>('.task-description-edit')!.click())
      const description = element.querySelector<HTMLTextAreaElement>('.task-detail-description textarea')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(description, 'Updated through share')
        description.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      await act(async () => [...element.querySelectorAll<HTMLButtonElement>('.task-description-actions button')]
        .find(button => button.textContent === '保存')!.click())
      assert.match(element.querySelector('.task-description-content')!.textContent!, /Updated through share/,
        'successful edits must refresh the share immediately without waiting for its poll timer')
      const confirmProposal = [...element.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === '确认')
      assert.ok(confirmProposal, 'interactive share coordinator action must be actionable')
      await act(async () => confirmProposal.click())
      assert.equal(operations.filter(item => item.path.includes('/actions/proposal-1/confirm')).length, 1)
      assert.match(element.textContent!, /succeeded/)
      const approve = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === '通过继续')
      assert.ok(approve, `review action missing: ${element.textContent}`)
      await act(async () => approve.click())
      assert.equal(operations.filter(item => item.path.includes('/review/approve')).length, 1)
      const allow = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === '允许本次操作')
      assert.ok(allow, 'pending permission action missing')
      await act(async () => allow.click())
      assert.equal(operations.filter(item => item.path.startsWith('/intervention/respond')).length, 1)
    }
    assert.ok(calls.every(path => path.startsWith('/api/public/shares/handle/')), JSON.stringify(calls.filter(path => !path.startsWith('/api/public/shares/handle/'))))
    assert.equal(calls.filter(path => path.endsWith('/unlock')).length, 0)
  } finally {
    await act(async () => root.unmount())
    element.remove(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket
    globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClearTimeout
    useUserSettingsStore.setState({ openMode: previousOpenMode })
    await window.happyDOM.close()
  }
})
