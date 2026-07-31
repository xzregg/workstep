import { create } from 'zustand'
import { taskApi, type Task, type TaskStepState } from '../api/client'

interface TaskEvent {
  type: string
  data: Record<string, unknown>
  task_id?: string
  step_key?: string
  timestamp?: number
}

interface TaskState {
  tasks: Task[]
  activeTaskId: string | null
  events: Record<string, TaskEvent[]> // task_id → events
  content: Record<string, string>     // task_id → accumulated text
  loading: boolean

  fetchTasks: (projectId: string, workflowId?: string | null) => Promise<void>
  setActiveTask: (id: string | null) => void
  createTask: (
    title: string,
    cwd: string,
    projectId: string,
    description?: string,
    startStepKey?: string,
    reviewOverrides?: Record<string, any> | null,
    workflowId?: string | null,
  ) => Promise<Task>
  runTask: (taskId: string, prompt: string, projectId: string) => Promise<void>
  cancelTask: (taskId: string) => Promise<void>
  pauseTask: (taskId: string, projectId: string) => Promise<void>
  updateTaskDescription: (
    taskId: string,
    description: string | undefined,
    projectId: string,
    reviewOverrides?: Record<string, any> | null,
  ) => Promise<Task>
  deleteTask: (taskId: string, projectId: string) => Promise<void>
  copyTask: (taskId: string, newTitle: string, projectId: string) => Promise<void>
  handleWsEvent: (event: TaskEvent) => void
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  activeTaskId: null,
  events: {},
  content: {},
  loading: false,

  fetchTasks: async (projectId: string, workflowId?: string | null) => {
    set({ loading: true })
    try {
      const { tasks } = await taskApi.list(projectId, workflowId)
      set({ tasks, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  setActiveTask: (id) => set({ activeTaskId: id }),

  createTask: async (title, cwd, projectId, description, startStepKey, reviewOverrides, workflowId) => {
    const task = await taskApi.create(
      title,
      cwd,
      projectId,
      'claude',
      description,
      startStepKey || null,
      reviewOverrides || null,
      workflowId || null,
    )
    set((s) => ({ tasks: [...s.tasks, task] }))
    return task
  },

  runTask: async (taskId, prompt, projectId) => {
    await taskApi.run(taskId, prompt, projectId)
    set((s) => ({
      content: { ...s.content, [taskId]: '' },
      events: { ...s.events, [taskId]: [] },
    }))
  },

  cancelTask: async (taskId) => {
    await taskApi.cancel(taskId)
  },

  pauseTask: async (taskId, projectId) => {
    await taskApi.pause(taskId, projectId)
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'paused' } : t,
      ),
    }))
  },

  updateTaskDescription: async (taskId, description, projectId, reviewOverrides) => {
    const updated = await taskApi.updateDescription(
      taskId,
      projectId,
      description,
      reviewOverrides,
    )
    set((s) => ({
      tasks: s.tasks.map((task) => task.id === taskId ? updated : task),
    }))
    return updated
  },

  deleteTask: async (taskId, projectId) => {
    await taskApi.delete(taskId, projectId)
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== taskId),
      activeTaskId: s.activeTaskId === taskId ? null : s.activeTaskId,
    }))
  },

  copyTask: async (taskId, newTitle, projectId) => {
    const copied = await taskApi.copy(taskId, newTitle, projectId)
    set((s) => ({ tasks: [...s.tasks, copied] }))
  },

  handleWsEvent: (event) => {
    const taskId = event.task_id
    if (!taskId) return
    const timedEvent = event.timestamp
      ? event
      : { ...event, timestamp: Date.now() }

    set((s) => {
      const prevEvents = s.events[taskId] || []
      const prevContent = s.content[taskId] || ''

      let newContent = prevContent
      if (event.type === 'text_delta') {
        newContent = prevContent + (event.data.delta as string || '')
      }

      let newTasks = s.tasks
      const isStatusEvent = [
        'status', 'review_status', 'review_result', 'step_retrying',
      ].includes(event.type)
      if (isStatusEvent) {
        const status = (
          event.type === 'step_retrying' ? 'retrying' : event.data.status
        ) as string
        const stepKey = event.step_key || event.data.step_key as string | undefined
        const isStepStatus = [
          'pending', 'running', 'reviewing', 'awaiting_review', 'retrying',
          'passed', 'rejected', 'failed', 'skipped',
        ].includes(status)
        const stepStatus = status as TaskStepState['status']
        const updateTaskStep = (task: Task) => ({
          ...task,
          steps: isStepStatus && stepKey
            ? (task.steps || []).map((step) =>
                step.step_key === stepKey ? { ...step, status: stepStatus } : step
              )
            : task.steps,
        })
        if (status === 'passed') {
          newTasks = s.tasks.map((t) =>
            t.id === taskId ? { ...updateTaskStep(t), status: 'ready' } : t,
          )
        } else if (['running', 'reviewing', 'retrying'].includes(status)) {
          newTasks = s.tasks.map((t) =>
            t.id === taskId ? { ...updateTaskStep(t), status: 'running' } : t,
          )
        } else if (['awaiting_review', 'rejected'].includes(status)) {
          newTasks = s.tasks.map((t) =>
            t.id === taskId ? { ...updateTaskStep(t), status: 'paused' } : t,
          )
        } else if (status === 'failed') {
          newTasks = s.tasks.map((t) =>
            t.id === taskId ? { ...updateTaskStep(t), status: 'stopped' } : t,
          )
        }
      }

      return {
        tasks: newTasks,
        events: { ...s.events, [taskId]: [...prevEvents, timedEvent] },
        content: { ...s.content, [taskId]: newContent },
      }
    })
  },
}))
