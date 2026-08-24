import { create } from 'zustand'
import { taskApi, type EngineInputItem, type Task, type TaskStepState } from '../api/client.ts'
import {
  CUSTOM,
  availableCommandInputItems,
  customValue,
  isCustom,
  isRunEvent,
  messageId,
} from '../utils/agui.ts'

export interface TaskEvent {
  type: string
  data?: Record<string, unknown>
  task_id?: string
  step_key?: string
  channel?: 'coordinator' | 'execution' | 'review'
  message_id?: string
  engine?: string
  model?: string
  event_sequence?: number
  created_at?: string
  timestamp?: number
  /** AG-UI 标准字段 */
  messageId?: string
  name?: string
  value?: Record<string, unknown>
  role?: string
  delta?: string
  content?: string
  prompt?: string
  status?: string
  error?: string
  ended_at?: string
  toolCallId?: string
  toolCallName?: string
  args?: unknown
  output?: unknown
  isError?: boolean
  sequence?: number
  actor?: { id?: string; name?: string; device_id?: string; device_name?: string }
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
  role?: 'user' | 'assistant'
  author_id?: string
  author_name?: string
  author_device_id?: string
  author_device_name?: string
  proposals: Array<Record<string, unknown>>
}

interface TaskState {
  tasks: Task[]
  activeTaskId: string | null
  events: Record<string, TaskEvent[]> // task_id → events
  content: Record<string, string>     // task_id → accumulated text
  liveMessages: Record<string, Record<string, LiveMessage>>
  availableCommands: Record<string, Record<string, EngineInputItem[]>>
  loading: boolean
  /** Incremented on every task status WS event, so the sidebar can refresh flow running state. */
  taskStatusEvents: number
  /** task_id → incremented whenever a user chat message arrives over WS. */
  userMessageEvents: Record<string, number>

  fetchTasks: (projectId: string, workflowId?: string | null, archived?: boolean) => Promise<void>
  refreshTask: (taskId: string, projectId: string) => Promise<Task>
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
    scheduledStartAt?: string | null,
  ) => Promise<Task>
  runTask: (taskId: string, prompt: string, projectId: string) => Promise<void>
  cancelTask: (taskId: string, projectId: string) => Promise<void>
  pauseTask: (taskId: string, projectId: string) => Promise<void>
  updateTaskDescription: (
    taskId: string,
    description: string | undefined,
    projectId: string,
    reviewOverrides?: Record<string, any> | null,
  ) => Promise<Task>
  updateScheduledStart: (taskId: string, scheduledStartAt: string | null, projectId: string) => Promise<Task>
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
  availableCommands: {},
  loading: false,
  taskStatusEvents: 0,
  userMessageEvents: {},

  fetchTasks: async (projectId: string, workflowId?: string | null, archived?: boolean) => {
    set({ loading: true })
    try {
      const { tasks } = await taskApi.list(projectId, workflowId, archived)
      set({ tasks, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  refreshTask: async (taskId, projectId) => {
    const task = await taskApi.get(taskId, projectId)
    set((s) => ({
      tasks: s.tasks.map((item) => item.id === taskId ? task : item),
    }))
    return task
  },

  setActiveTask: (id) => set({ activeTaskId: id }),

  createTask: async (title, cwd, projectId, description, startStepKey, reviewOverrides, workflowId, autoStart, scheduledStartAt) => {
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
      scheduledStartAt || null,
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

  cancelTask: async (taskId, projectId) => {
    await taskApi.cancel(taskId, projectId)
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

  updateScheduledStart: async (taskId, scheduledStartAt, projectId) => {
    const updated = await taskApi.updateScheduledStart(taskId, projectId, scheduledStartAt)
    set((s) => ({ tasks: s.tasks.map((task) => task.id === taskId ? updated : task) }))
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
    const mid = messageId(event)
    const isUserMessageEvent = (
      event.type === 'TEXT_MESSAGE_START'
      || event.type === 'TEXT_MESSAGE_CHUNK'
    ) && event.role === 'user'
    if (isUserMessageEvent) {
      useTaskStore.setState((st) => ({
        userMessageEvents: {
          ...st.userMessageEvents,
          [taskId]: (st.userMessageEvents[taskId] || 0) + 1,
        },
      }))
    }
    const isStatusEvent = isRunEvent(event)
      || isCustom(event, CUSTOM.status)
      || isCustom(event, CUSTOM.stepRetrying)
    if (isStatusEvent) {
      // Bump the counter so the sidebar can refresh flow running state.
      useTaskStore.setState((st) => ({ taskStatusEvents: st.taskStatusEvents + 1 }))
    }
    const isRecoveredEvent = isCustom(event, CUSTOM.runRecovered)
    if (isRecoveredEvent) {
      // Daemon restart resumed the run from its last completed stage.
      useTaskStore.setState((st) => ({ taskStatusEvents: st.taskStatusEvents + 1 }))
    }

    set((s) => {
      if (isUserMessageEvent) {
        // User messages are rendered from persisted history, not as live
        // bubbles. Keep the event in the task stream and let the open detail
        // panel refresh its history when the counter changes.
        const prevEvents = s.events[taskId] || []
        return {
          events: { ...s.events, [taskId]: [...prevEvents, timedEvent] },
        }
      }
      if (isCustom(event, CUSTOM.availableCommandsUpdate)) {
        const scope = `${event.channel || 'execution'}:${event.step_key || ''}`
        return {
          availableCommands: {
            ...s.availableCommands,
            [taskId]: {
              ...(s.availableCommands[taskId] || {}),
              [scope]: availableCommandInputItems(customValue(event)),
            },
          },
        }
      }
      if (isCustom(event, CUSTOM.scheduledStart)) {
        const value = customValue(event)
        const scheduledAt = value.scheduled_start_at as string | null | undefined
        const scheduledState = value.scheduled_start_state as Task['scheduled_start_state']
        const scheduledError = value.scheduled_start_error as string | null | undefined
        return {
          tasks: s.tasks.map((task) => task.id === taskId
            ? {
                ...task,
                scheduled_start_at: scheduledAt,
                scheduled_start_state: scheduledState,
                scheduled_start_error: scheduledError,
              }
            : task),
          events: { ...s.events, [taskId]: [...(s.events[taskId] || []), timedEvent] },
        }
      }
      if (mid) {
        const taskMessages = s.liveMessages[taskId] || {}
        const current = taskMessages[mid] || {
          id: mid,
          channel: event.channel || 'execution',
          step_key: event.step_key,
          role: event.type === 'TEXT_MESSAGE_START'
            ? event.role
            : event.type === 'TEXT_MESSAGE_CHUNK' && event.role === 'user'
              ? 'user'
              : undefined,
          content: '',
          events: [],
          status: 'running',
          engine: event.engine,
          model: event.model,
          prompt: event.type === 'TEXT_MESSAGE_START'
            ? String(event.prompt ?? (event.data as Record<string, unknown> | undefined)?.prompt ?? '')
            : undefined,
          created_at: event.created_at,
          author_id: event.actor?.id,
          author_name: event.actor?.name,
          author_device_id: event.actor?.device_id,
          author_device_name: event.actor?.device_name,
          proposals: [],
        }
        const nextContent = event.type === 'TEXT_MESSAGE_CHUNK'
          ? current.content + String(event.delta ?? '')
          : event.type === 'TEXT_MESSAGE_CONTENT'
            ? (typeof event.content === 'string'
              ? event.content
              : String(event.delta ?? current.content))
            : current.content
        const nextStatus = event.type === 'TEXT_MESSAGE_END'
          ? String(event.status ?? 'succeeded')
          : current.status
        const nextProposals = isCustom(event, CUSTOM.actionProposal)
          ? [...current.proposals, customValue(event)]
          : current.proposals
        return {
          liveMessages: {
            ...s.liveMessages,
            [taskId]: {
              ...taskMessages,
              [mid]: {
                ...current,
                content: nextContent,
                status: nextStatus,
                role: current.role
                  ?? (event.type === 'TEXT_MESSAGE_CHUNK' && event.role === 'user'
                    ? 'user'
                    : undefined),
                engine: event.engine || current.engine,
                model: event.model || current.model,
                prompt: event.type === 'TEXT_MESSAGE_START'
                  ? String(event.prompt ?? (event.data as Record<string, unknown> | undefined)?.prompt ?? '')
                  : current.prompt,
                created_at: current.created_at || event.created_at,
                author_id: current.author_id || event.actor?.id,
                author_name: current.author_name || event.actor?.name,
                author_device_id: current.author_device_id || event.actor?.device_id,
                author_device_name: current.author_device_name || event.actor?.device_name,
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
      if (event.type === 'TEXT_MESSAGE_CHUNK') {
        newContent = prevContent + String(event.delta ?? '')
      }

      let newTasks = s.tasks
      if (isRecoveredEvent) {
        const value = customValue(event)
        const recoveredAt = value.recovered_at as string | undefined
        const recoveredCount = Number(value.recovered_count ?? 1)
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
        const value = customValue(event)
        const status = (
          isCustom(event, CUSTOM.stepRetrying)
            ? 'retrying'
            : event.status ?? value.status
        ) as string
        const stepKey = event.step_key || value.step_key as string | undefined
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
