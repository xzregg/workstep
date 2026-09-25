import type { LiveMessage } from '../stores/taskStore'
import {
  isUnpersistedLiveMessage,
  isVisibleLiveExecutionMessage,
  isVisibleHistoryMessage,
  latestExecutionMessageIdsByStep,
  latestMessageIdsByStep,
  mergeHistoryMessageWithLive,
  orderConversationMessages,
} from '../pages/taskDetailChat'
import { shouldShowAssistantThinking } from '../utils/assistantThinking'
import { mergeActionMessages, type ActionRunLike } from '../utils/actionConversation'
import { toMilliseconds } from '../utils/datetime'

export function lastEventTimestamp(events: any[]): number | null {
  let latest: number | null = null
  for (const event of events || []) {
    const timestamp = toMilliseconds(event?.created_at ?? event?.timestamp)
    if (timestamp !== null && (latest === null || timestamp > latest)) latest = timestamp
  }
  return latest
}

/** Select only live messages that the persisted timeline cannot render yet. */
export function selectTaskConversationFeed(
  historyMessages: Array<{ id: string; channel?: string }>,
  liveMessages: Record<string, LiveMessage>,
) {
  const persistedIds = new Set(historyMessages.map((message) => String(message.id)))
  const live = Object.values(liveMessages)
  const unpersistedLiveMessages = live.filter((message) => (
    isUnpersistedLiveMessage(message, persistedIds)
  ))
  return {
    unpersistedLiveMessages,
    liveCoordinatorMessages: unpersistedLiveMessages.filter((message) => (
      message.channel === 'coordinator'
    )),
    liveExecutionMessages: unpersistedLiveMessages.filter((message) => (
      isVisibleLiveExecutionMessage(message)
    )),
    hasStructuredExecutionMessage: live.some((message) => message.channel === 'execution')
      || historyMessages.some((message) => message.channel === 'execution'),
  }
}

/** Produce the visible timeline and latest-message indexes for message actions. */
export function buildTaskConversationTimeline({
  historyMessages, liveMessages, actionRuns, coordinatorRunning, actionTitle,
}: {
  historyMessages: any[]
  liveMessages: Record<string, LiveMessage>
  actionRuns: Array<ActionRunLike & { ended_at?: string | null }>
  coordinatorRunning: boolean
  actionTitle: (title: string) => string
}) {
  const feed = selectTaskConversationFeed(historyMessages, liveMessages)
  const allCoordinatorMessages = [...historyMessages, ...feed.liveCoordinatorMessages]
  const showThinking = shouldShowAssistantThinking(
    coordinatorRunning, allCoordinatorMessages, 'coordinator',
  )
  const latestCoordinatorUser = allCoordinatorMessages
    .filter((message) => message.channel === 'coordinator' && message.role === 'user')
    .at(-1)
  const visibleMessages: any[] = [
    ...historyMessages
      .filter((message) => isVisibleHistoryMessage(message))
      .map((message) => mergeHistoryMessageWithLive(message, liveMessages[String(message.id)])),
    ...feed.liveExecutionMessages.map((message) => ({
      ...message,
      run_status: message.status,
      ended_at: message.status === 'running' ? undefined : lastEventTimestamp(message.events),
    })),
    ...feed.liveCoordinatorMessages.map((message) => ({
      ...message, run_status: message.status,
    })),
    ...(showThinking ? [{
      id: 'pending-coordinator-thinking',
      channel: 'coordinator',
      role: 'assistant',
      content: '',
      run_status: 'running',
      created_at: latestCoordinatorUser?.created_at || new Date().toISOString(),
      started_at: latestCoordinatorUser?.started_at || latestCoordinatorUser?.created_at,
      reply_to_message_id: latestCoordinatorUser?.id,
      thinkingPlaceholder: true,
    }] : []),
  ]
  const orderedMessages = orderConversationMessages(mergeActionMessages(
    visibleMessages,
    actionRuns,
    (message) => message.channel === 'action',
    (run, role) => ({
      id: role === 'user' ? run.user_message_id : run.reply_message_id,
      channel: 'action', role,
      content: role === 'user' ? actionTitle(run.title) : run.output,
      created_at: run.started_at,
      started_at: run.started_at,
      ended_at: role === 'assistant' ? run.ended_at : run.started_at,
      run_status: role === 'assistant' ? run.status : 'succeeded',
      reply_to_message_id: role === 'assistant' ? run.user_message_id : undefined,
    }),
  ))
  const orderedStepMessages = orderConversationMessages([
    ...historyMessages,
    ...feed.unpersistedLiveMessages.map((item) => ({
      ...item, run_status: item.status,
    })),
  ])
  return {
    ...feed,
    orderedMessages,
    latestStepMessageIds: latestMessageIdsByStep(orderedStepMessages),
    latestExecutionMessageIds: latestExecutionMessageIdsByStep(orderedStepMessages),
  }
}
