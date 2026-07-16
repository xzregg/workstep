import { create } from 'zustand'
import { taskApi, type Task } from '../api/client'

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

  fetchTasks: (projectId: string) => Promise<void>
  setActiveTask: (id: string | null) => void
  createTask: (title: string, cwd: string, projectId: string) => Promise<Task>
  runTask: (taskId: string, prompt: string, projectId: string) => Promise<void>
  cancelTask: (taskId: string) => Promise<void>
  handleWsEvent: (event: TaskEvent) => void
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  activeTaskId: null,
  events: {},
  content: {},
  loading: false,

  fetchTasks: async (projectId: string) => {
    set({ loading: true })
    try {
      const { tasks } = await taskApi.list(projectId)
      set({ tasks, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  setActiveTask: (id) => set({ activeTaskId: id }),

  createTask: async (title, cwd, projectId) => {
    const task = await taskApi.create(title, cwd, projectId)
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

  handleWsEvent: (event) => {
    const taskId = event.task_id
    if (!taskId) return

    set((s) => {
      const prevEvents = s.events[taskId] || []
      const prevContent = s.content[taskId] || ''

      let newContent = prevContent
      if (event.type === 'text_delta') {
        newContent = prevContent + (event.data.delta as string || '')
      }

      let newTasks = s.tasks
      if (event.type === 'status') {
        const status = event.data.status as string
        if (status === 'passed') {
          newTasks = s.tasks.map((t) =>
            t.id === taskId ? { ...t, status: 'ready' } : t,
          )
        } else if (status === 'running') {
          newTasks = s.tasks.map((t) =>
            t.id === taskId ? { ...t, status: 'running' } : t,
          )
        } else if (status === 'failed') {
          newTasks = s.tasks.map((t) =>
            t.id === taskId ? { ...t, status: 'stopped' } : t,
          )
        }
      }

      return {
        tasks: newTasks,
        events: { ...s.events, [taskId]: [...prevEvents, event] },
        content: { ...s.content, [taskId]: newContent },
      }
    })
  },
}))
