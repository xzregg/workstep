import { create } from 'zustand'
import { taskApi, type EngineInputItem, type Task, type TaskStepState } from '../api/client.ts'
import { useProjectStore } from './projectStore.ts'
import {
  CUSTOM,
  appendMessageContent,
  availableCommandInputItems,
  customValue,
  isCustom,
  isRunEvent,
  messageId,
} from '../utils/agui.ts'

/**
 * 单任务 / 单消息在前端 live 保留的事件上限。长任务（子代理、流式思考）可产生
 * 上万条事件，逐条整数组复制是 O(n²)，且事件在任务生命周期内从不释放——后台
 * 任务越多渲染进程内存涨得越快，是标签页 OOM 崩溃的主要来源之一。超限只保留
 * 最近 N 条；完整事件流服务端已持久化，展开详情时经 messageEvents 懒加载。
 */
const MAX_LIVE_EVENTS_PER_TASK = 2000

function appendCappedEvent(events: TaskEvent[] | undefined, event: TaskEvent): TaskEvent[] {
  const combined = [...(events || []), event]
  return combined.length > MAX_LIVE_EVENTS_PER_TASK
    ? combined.slice(-MAX_LIVE_EVENTS_PER_TASK)
    : combined
}

export interface TaskEvent {
  type: string
  data?: Record<string, unknown>
  task_id?: string
  project_id?: string
  step_key?: string
  channel?: 'coordinator' | 'execution' | 'review' | 'archive_experience'
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
  phase?: string
  source_item_id?: string
  content?: string
  prompt?: string
  artifact_round?: number
  status?: string
  error?: string
  ended_at?: string
  started_at?: string
  retry?: boolean
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
  channel: 'coordinator' | 'execution' | 'review' | 'archive_experience'
  step_key?: string
  content: string
  events: TaskEvent[]
  status: string
  engine?: string
  model?: string
  prompt?: string
  artifact_round?: number | null
  created_at?: string
  started_at?: string
  restarted?: boolean
  role?: 'user' | 'assistant'
  author_id?: string
  author_name?: string
  author_device_id?: string
  author_device_name?: string
  proposals: Array<Record<string, unknown>>
}

export interface ArchiveExperienceDraft {
  found: boolean
  message_id: string | null
  experience: string
  has_experience: boolean
  events: TaskEvent[]
  prompt: string
}

interface TaskState {
  tasks: Task[]
  activeTaskId: string | null
  events: Record<string, TaskEvent[]> // task_id → events
  content: Record<string, string>     // task_id → accumulated text
  liveMessages: Record<string, Record<string, LiveMessage>>
  availableCommands: Record<string, Record<string, EngineInputItem[]>>
  loading: boolean
  listQuery: { projectId: string; workflowId: string | null; archived: boolean } | null
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
  getArchiveExperienceDraft: (taskId: string, projectId: string) => Promise<ArchiveExperienceDraft>
  prepareArchiveExperience: (taskId: string, projectId: string, messageId: string) => Promise<ArchiveExperienceDraft>
  stopArchiveExperience: (taskId: string, projectId: string, messageId: string) => Promise<boolean>
  confirmArchiveExperience: (taskId: string, projectId: string, experience: string) => Promise<void>
  unarchiveTask: (taskId: string, projectId: string) => Promise<void>
  copyTask: (taskId: string, newTitle: string, projectId: string) => Promise<void>
  handleWsEvent: (event: TaskEvent) => void
}

type TaskListQuery = NonNullable<TaskState['listQuery']>

const taskListRequests = new Map<string, {
  query: TaskListQuery
  promise: Promise<void>
}>()

export function selectWorkflowTasks(tasks: Task[], workflowId: string | null, archived: boolean): Task[] {
  return tasks.filter(task => (
    Boolean(task.archived) === archived
    && (!workflowId || task.workflow_id === workflowId)
  ))
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  activeTaskId: null,
  events: {},
  content: {},
  liveMessages: {},
  availableCommands: {},
  loading: false,
  listQuery: null,
  taskStatusEvents: 0,
  userMessageEvents: {},

  fetchTasks: async (projectId: string, workflowId?: string | null, archived?: boolean) => {
    const previous = get().listQuery
    // Background refreshes omit filters; retain the current board selection.
    const query = {
      projectId,
      workflowId: workflowId === undefined && previous?.projectId === projectId
        ? previous.workflowId : workflowId ?? null,
      archived: archived ?? (previous?.projectId === projectId ? previous.archived : false),
    }
    const requestKey = JSON.stringify(query)
    const existing = taskListRequests.get(requestKey)
    if (existing) {
      // The user may switch away and back while the first request is pending.
      // Re-select its query so that response is still allowed to update the board.
      if (get().listQuery !== existing.query) {
        set({ loading: true, listQuery: existing.query })
      }
      return existing.promise
    }

    set({ loading: true, listQuery: query })
    const promise = Promise.resolve()
      .then(() => taskApi.list(projectId, query.workflowId, query.archived))
      .then(({ tasks }) => {
        if (get().listQuery === query) set({ tasks, loading: false })
      })
      .catch(() => {
        if (get().listQuery === query) set({ loading: false })
      })
      .finally(() => {
        taskListRequests.delete(requestKey)
      })
    taskListRequests.set(requestKey, { query, promise })
    return promise
  },

  refreshTask: async (taskId, projectId) => {
    const task = await taskApi.get(taskId, projectId)
    set((s) => ({
      tasks: s.tasks.some((item) => item.id === taskId)
        ? s.tasks.map((item) => item.id === taskId ? task : item)
        : [...s.tasks, task],
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

  getArchiveExperienceDraft: async (taskId, projectId) => {
    const result = await taskApi.getArchiveExperienceDraft(taskId, projectId)
    return {
      ...result,
      events: result.events as unknown as TaskEvent[],
    }
  },

  prepareArchiveExperience: async (taskId, projectId, messageId) => {
    const result = await taskApi.prepareArchiveExperience(taskId, projectId, messageId)
    return { ...result, found: true, events: [], prompt: '' }
  },

  stopArchiveExperience: async (taskId, projectId, messageId) => {
    const result = await taskApi.stopArchiveExperience(taskId, projectId, messageId)
    return result.stopped
  },

  confirmArchiveExperience: async (taskId, projectId, experience) => {
    await taskApi.confirmArchiveExperience(taskId, projectId, experience)
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
      // Bump the counter so other consumers (e.g. statistics) can react.
      useTaskStore.setState((st) => ({ taskStatusEvents: st.taskStatusEvents + 1 }))
      // Update local per-project running state from the event's project_id.
      const eventId = event.project_id as string | undefined
      if (eventId) {
        const value = customValue(event)
        const status = (
          isCustom(event, CUSTOM.stepRetrying)
            ? 'retrying'
            : event.status ?? value.status
        ) as string || ''
        const isRunning = ['running', 'reviewing', 'retrying'].includes(status)
        if (isRunning) {
          useProjectStore.getState().setProjectRunning(eventId, true)
        } else if (['passed', 'failed', 'cancelled', 'ready', 'stopped', 'paused', 'skipped'].includes(status)) {
          // For the active project we have the full tasks array; check if
          // any task is still running before clearing the flag.
          const { activeProject } = useProjectStore.getState()
          if (activeProject?.id === eventId) {
            const stillRunning = useTaskStore.getState().tasks.some((t) => t.status === 'running')
            useProjectStore.getState().setProjectRunning(eventId, stillRunning)
          }
          // Non-active projects: leave as true (conservative; corrected on reload).
        }
      }
    }
    const isRecoveredEvent = isCustom(event, CUSTOM.runRecovered)
    if (isRecoveredEvent) {
      // Daemon restart resumed the run from its last completed step.
      useTaskStore.setState((st) => ({ taskStatusEvents: st.taskStatusEvents + 1 }))
    }

    set((s) => {
      if (isUserMessageEvent) {
        // User messages are rendered from persisted history, not as live
        // bubbles. Keep the event in the task stream and let the open detail
        // panel refresh its history when the counter changes.
        const prevEvents = s.events[taskId] || []
        return {
          events: { ...s.events, [taskId]: appendCappedEvent(prevEvents, timedEvent) },
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
          events: { ...s.events, [taskId]: appendCappedEvent(s.events[taskId], timedEvent) },
        }
      }
      if (mid) {
        const taskMessages = s.liveMessages[taskId] || {}
        const restarted = event.type === 'TEXT_MESSAGE_START' && event.retry === true
        const current: LiveMessage = (!restarted && taskMessages[mid]) || {
          id: mid,
          channel: event.channel || 'execution',
          step_key: event.step_key,
          role: event.type === 'TEXT_MESSAGE_START'
            ? (event.role === 'user' ? 'user' : 'assistant')
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
          artifact_round: typeof event.artifact_round === 'number'
            ? event.artifact_round
            : undefined,
          created_at: taskMessages[mid]?.created_at || event.created_at,
          started_at: event.started_at || event.created_at,
          restarted,
          author_id: event.actor?.id,
          author_name: event.actor?.name,
          author_device_id: event.actor?.device_id,
          author_device_name: event.actor?.device_name,
          proposals: [],
        }
        const nextContent = appendMessageContent(current.content, event)
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
                artifact_round: typeof event.artifact_round === 'number'
                  ? event.artifact_round
                  : current.artifact_round,
                created_at: current.created_at || event.created_at,
                started_at: current.started_at || event.started_at,
                restarted: current.restarted || restarted,
                author_id: current.author_id || event.actor?.id,
                author_name: current.author_name || event.actor?.name,
                author_device_id: current.author_device_id || event.actor?.device_id,
                author_device_name: current.author_device_name || event.actor?.device_name,
                proposals: nextProposals,
                events: appendCappedEvent(current.events, timedEvent),
              },
            },
          },
        }
      }
      const prevEvents = s.events[taskId] || []
      const prevContent = s.content[taskId] || ''

      let newContent = prevContent
      if (event.type === 'TEXT_MESSAGE_CHUNK') {
        newContent = appendMessageContent(prevContent, event)
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
        events: { ...s.events, [taskId]: appendCappedEvent(prevEvents, timedEvent) },
        content: { ...s.content, [taskId]: newContent },
      }
    })
  },
}))
