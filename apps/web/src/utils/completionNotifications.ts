export interface CompletionNotice {
  id: string
  projectId: string
  sessionId: string | null
  taskId: string | null
  stepKey?: string
  outcome: 'succeeded' | 'failed'
  title: string
  body: string
}

interface TerminalEvent {
  type?: string
  channel?: string
  project_id?: string
  session_id?: string
  task_id?: string
  messageId?: string
  status?: string
  step_key?: string
  sequence?: number
}

export function completionNotice(event: TerminalEvent): CompletionNotice | null {
  if (event.step_key && event.project_id && event.task_id &&
      (event.type === 'RUN_FINISHED' && event.status === 'passed' ||
       event.type === 'RUN_ERROR' && event.status === 'failed')) {
    const success = event.status === 'passed'
    return {
      id: `${event.project_id}:${event.task_id}:step:${event.step_key}:${event.sequence ?? event.status}`,
      projectId: event.project_id,
      sessionId: null,
      taskId: event.task_id,
      stepKey: event.step_key,
      outcome: success ? 'succeeded' : 'failed',
      title: success ? 'WorkStep 步骤完成' : 'WorkStep 步骤失败',
      body: `步骤 ${event.step_key} ${success ? '已通过' : '执行失败'}`,
    }
  }
  if (event.type !== 'TEXT_MESSAGE_END' || !event.project_id || !event.messageId) return null
  const taskId = event.channel === 'session_chat' && event.session_id ? null : event.task_id || null
  if (!event.session_id && !taskId) return null
  if (event.status !== 'succeeded' && event.status !== 'failed' && event.status !== 'error') return null
  const outcome = event.status === 'succeeded' ? 'succeeded' : 'failed'
  return {
    id: `${event.project_id}:${event.session_id || event.task_id}:${event.messageId}`,
    projectId: event.project_id,
    sessionId: event.session_id || null,
    taskId,
    outcome,
    title: outcome === 'succeeded' ? 'WorkStep 回复完成' : 'WorkStep 回复失败',
    body: taskId
      ? `任务的回复${outcome === 'succeeded' ? '已完成' : '失败'}`
      : `会话的回复${outcome === 'succeeded' ? '已完成' : '失败'}`,
  }
}

export class CompletionDeduplicator {
  private seen = new Set<string>()
  take(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!)
    return true
  }
}

type NativeBridge = { postMessage: (message: string) => void }
type DesktopBridge = { notify: (notice: CompletionNotice & { url: string }) => void }

declare global {
  interface Window {
    WorkStepAndroid?: NativeBridge
    workstepDesktop?: DesktopBridge
  }
}

const deduplicator = new CompletionDeduplicator()

export function pendingCompletionId(projectId: string, scopeId: string): string {
  return `${projectId}:${scopeId}:pending`
}

export function watchPendingCompletion(projectId: string, scope: { sessionId?: string; taskId?: string }): void {
  const scopeId = scope.sessionId || scope.taskId
  if (!scopeId) return
  try {
    window.WorkStepAndroid?.postMessage(JSON.stringify({
      type: 'watch', id: pendingCompletionId(projectId, scopeId), projectId,
      sessionId: scope.sessionId || null, taskId: scope.taskId || null,
      url: window.location.pathname + window.location.search,
    }))
  } catch (error) { console.warn('[Android] reply watch failed:', error) }
}

export function unwatchPendingCompletion(projectId: string, scope: { sessionId?: string; taskId?: string }): void {
  const scopeId = scope.sessionId || scope.taskId
  if (!scopeId) return
  try {
    window.WorkStepAndroid?.postMessage(JSON.stringify({ type: 'unwatch', id: pendingCompletionId(projectId, scopeId) }))
  } catch (error) { console.warn('[Android] reply unwatch failed:', error) }
}

export function notifyCompletion(notice: CompletionNotice, url: string): void {
  if (!deduplicator.take(notice.id)) return
  if (window.WorkStepAndroid) {
    window.WorkStepAndroid.postMessage(JSON.stringify({ type: 'notify', ...notice, url }))
    return
  }
  if (window.workstepDesktop) {
    window.workstepDesktop.notify({ ...notice, url })
    return
  }
  if (document.visibilityState === 'visible') return
  if ('Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(notice.title, { body: notice.body, tag: notice.id })
    notification.onclick = () => { window.focus(); window.location.assign(url); notification.close() }
  }
}

export function notificationUrl(notice: CompletionNotice, projectName: string | undefined,
  workflowId?: string | null): string {
  const project = encodeURIComponent(projectName || '')
  if (notice.taskId) return `/tasks?project=${project}${workflowId ? `&workflow=${encodeURIComponent(workflowId)}` : ''}&task=${encodeURIComponent(notice.taskId)}`
  return `/chat?project=${project}&session=${encodeURIComponent(notice.sessionId || '')}`
}
