/** Store for the ephemeral task-creation assistant. */

import { createAssistantStore } from './assistantStore.ts'


export interface TaskDraftResult extends Record<string, unknown> {
  description: string
  start_step_key: string
}

export const useTaskDraftStore = createAssistantStore({
  channel: 'task_create',
  resultEvent: 'task_draft',
  resultExtractor: (data) => {
    const description = data.description
    const startStepKey = data.start_step_key
    return typeof description === 'string' && description.trim()
      && typeof startStepKey === 'string' && startStepKey
      ? { description: description.trim(), start_step_key: startStepKey }
      : undefined
  },
  generateFailedText: () => '生成任务失败',
})
