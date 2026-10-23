/** Store for the ephemeral task-creation assistant. */

import { createAssistantStore } from './assistantStore.ts'
import { CUSTOM } from '../utils/agui.ts'


export interface TaskDraftResult extends Record<string, unknown> {
  description: string
  start_step_key: string
  title?: string
  task_drafts?: TaskDraftResult[]
  scheduled_start_at?: string | null
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
    if (typeof data.scheduled_start_at === 'string') result.scheduled_start_at = data.scheduled_start_at
    if (Array.isArray(data.task_drafts)) {
      result.task_drafts = data.task_drafts.filter((item): item is TaskDraftResult =>
        !!item && typeof item === 'object' && typeof item.description === 'string')
    }
    return result
  },
  generateFailedText: () => '生成任务失败',
})
