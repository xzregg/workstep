import { create } from 'zustand'
import { taskApi, type Task, type TaskStepState } from '../api/client'

export interface TaskEvent {
  type: string
  data: Record<string, unknown>
  task_id?: string
  step_key?: string
  channel?: 'coordinator' | 'execution' | 'review'
  message_id?: string
  engine?: string
  model?: string
  event_sequence?: number
  created_at?: string
  timestamp?: number
}

export interface LiveMessage {
  id: string
  channel: 'coordinator' | 'execution' | 'review'
  step_key?: string
  content: string
  events: TaskEvent[]
  status: string
  engine?: string
  model?: string
  prompt?: string
  created_at?: string
  proposals: Array<Record<string, unknown>>
}

interface TaskState {
  tasks: Task[]
  activeTaskId: string | null
  events: Record<string, TaskEvent[]> // task_id → events
  content: Record<string, string>     // task_id → accumulated text
  liveMessages: Record<string, Record<string, LiveMessage>>
  loading: boolean
  /** Incremented on every task status WS event, so the sidebar can refresh flow running state. */
  taskStatusEvents: number

  fetchTasks: (projectId: string, workflowId?: string | null, archived?: boolean) => Promise<void>
  setActiveTask: (id: string | null) => void
  createTask: (
    title: string,
    cwd: string,
    projectId: string,
    description?: string,
    startStepKey?: string,
    reviewOverrides?: Record<string, any> | null,
    workflowId?: string | null,
    autoStart?: boolean,
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
  archiveTask: (taskId: string, projectId: string) => Promise<void>
  unarchiveTask: (taskId: string, projectId: string) => Promise<void>
  copyTask: (taskId: string, newTitle: string, projectId: string) => Promise<void>
  handleWsEvent: (event: TaskEvent) => void
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  activeTaskId: null,
  events: {},
  content: {},
  liveMessages: {},
  loading: false,
  taskStatusEvents: 0,

  fetchTasks: async (projectId: string, workflowId?: string | null, archived?: boolean) => {
    set({ loading: true })
    try {
      const { tasks } = await taskApi.list(projectId, workflowId, archived)
      set({ tasks, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  setActiveTask: (id) => set({ activeTaskId: id }),

  createTask: async (title, cwd, projectId, description, startStepKey, reviewOverrides, workflowId, autoStart) => {
    const task = await taskApi.create(
      title,
      cwd,
      projectId,
      undefined,
      description,
      startStepKey || null,
      reviewOverrides || null,
      workflowId || null,
      autoStart,
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

  archiveTask: async (taskId, projectId) => {
    await taskApi.archive(taskId, projectId)
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, archived: true } : t)),
    }))
  },

  unarchiveTask: async (taskId, projectId) => {
    await taskApi.unarchive(taskId, projectId)
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, archived: false } : t)),
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
    const isStatusEvent = [
      'status', 'review_status', 'review_result', 'step_retrying',
    ].includes(event.type)
    if (isStatusEvent) {
      // Bump the counter so the sidebar can refresh flow running state.
      useTaskStore.setState((st) => ({ taskStatusEvents: st.taskStatusEvents + 1 }))
    }
    const isRecoveredEvent = event.type === 'run_recovered'
    if (isRecoveredEvent) {
      // Daemon restart resumed the run from its last completed stage.
      useTaskStore.setState((st) => ({ taskStatusEvents: st.taskStatusEvents + 1 }))
    }

    set((s) => {
      if (event.message_id) {
        const taskMessages = s.liveMessages[taskId] || {}
        const current = taskMessages[event.message_id] || {
          id: event.message_id,
          channel: event.channel || 'execution',
          step_key: event.step_key,
          role: event.type === 'message_started'
            ? event.data.role
            : event.type === 'live_message'
              ? 'user'
              : undefined,
          content: '',
          events: [],
          status: 'running',
          engine: event.engine,
          model: event.model,
          prompt: event.type === 'message_started'
            ? String(event.data.prompt || '')
            : undefined,
          created_at: event.created_at,
          proposals: [],
        }
        const nextContent = event.type === 'text_delta'
          ? current.content + String(event.data.delta || '')
          : event.type === 'message_snapshot'
            ? String(event.data.content || '')
            : current.content
        const nextStatus = event.type === 'message_completed'
          ? String(event.data.status || 'succeeded')
          : current.status
        const nextProposals = event.type === 'action_proposal'
          ? [...current.proposals, event.data]
          : current.proposals
        return {
          liveMessages: {
            ...s.liveMessages,
            [taskId]: {
              ...taskMessages,
              [event.message_id]: {
                ...current,
                content: nextContent,
                status: nextStatus,
                engine: event.engine || current.engine,
                model: event.model || current.model,
                prompt: event.type === 'message_started'
                  ? String(event.data.prompt || '')
                  : current.prompt,
                created_at: current.created_at || event.created_at,
                proposals: nextProposals,
                events: [...current.events, timedEvent],
              },
            },
          },
        }
      }
      const prevEvents = s.events[taskId] || []
      const prevContent = s.content[taskId] || ''

      let newContent = prevContent
      if (event.type === 'text_delta') {
        newContent = prevContent + (event.data.delta as string || '')
      }

      let newTasks = s.tasks
      if (isRecoveredEvent) {
        const recoveredAt = event.data?.recovered_at as string | undefined
        const recoveredCount = Number(event.data?.recovered_count ?? 1)
        newTasks = s.tasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                status: 'running',
                recovered_at: recoveredAt || t.recovered_at,
                recovered_count: recoveredCount,
              }
            : t,
        )
      }
      if (isStatusEvent) {
        const status = (
          event.type === 'step_retrying' ? 'retrying' : event.data.status
        ) as string
        const stepKey = event.step_key || event.data.step_key as string | undefined
        const isStepStatus = [
          'pending', 'running', 'reviewing', 'awaiting_review', 'retrying',
          'passed', 'rejected', 'failed', 'cancelled', 'skipped',
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
        } else if (status === 'failed' || status === 'cancelled') {
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
