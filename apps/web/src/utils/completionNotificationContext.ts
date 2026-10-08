import { useChatListStore } from '../stores/chatSessionStore'
import { useTaskStore } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'

/** Read existing page data; registering a watch must never wait for a request. */
export function completionScopeName(projectId: string, scope: { sessionId?: string | null; taskId?: string | null }): string {
  if (scope.taskId) {
    const title = useProjectStore.getState().activeProject?.id === projectId
      ? useTaskStore.getState().tasks.find(task => task.id === scope.taskId)?.title : undefined
    return shortNotificationName(title?.trim() || `任务 ${scope.taskId}`)
  }
  const title = useChatListStore.getState().sessionsByProject[projectId]
    ?.find(session => session.id === scope.sessionId)?.title
  return shortNotificationName(title?.trim() || `会话 ${scope.sessionId || ''}`.trim())
}

/** Keep room for the result suffix and avoid splitting UTF-16 surrogate pairs. */
function shortNotificationName(value: string): string {
  const characters = Array.from(value.replace(/\s+/g, ' ').trim())
  return characters.length > 20 ? characters.slice(0, 19).join('') + '…' : characters.join('')
}
