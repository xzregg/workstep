/** Store for the ephemeral task-creation assistant. */

import { createAssistantStore } from './assistantStore.ts'
import { CUSTOM } from '../utils/agui.ts'


export interface TaskDraftResult extends Record<string, unknown> {
  description: string
  start_step_key: string
  title?: string
  workflow_id?: string
}

export const useTaskDraftStore = createAssistantStore({
  channel: 'task_create',
  resultEvent: CUSTOM.taskDraft,
  resultExtractor: (data) => {
    const description = data.description
    const startStepKey = data.start_step_key
    if (typeof description !== 'string' || !description.trim()) return undefined
    const result: TaskDraftResult = {
      description: description.trim(),
      start_step_key: typeof startStepKey === 'string' ? startStepKey : '',
    }
    if (typeof data.title === 'string' && data.title.trim()) {
      result.title = data.title.trim()
    }
    if (typeof data.workflow_id === 'string' && data.workflow_id) {
      result.workflow_id = data.workflow_id
    }
    return result
  },
  generateFailedText: () => '生成任务失败',
})
