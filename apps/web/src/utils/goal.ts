import { CUSTOM, customValue, isCustom } from './agui'
import type { InteractionEvent } from './interaction'

export interface GoalSnapshot {
  objective: string
  status: string
  tokens_used?: number
  token_budget?: number
}

export function latestGoalFromEvents(events: InteractionEvent[]): GoalSnapshot | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'goal_update' && !isCustom(event, CUSTOM.goalUpdate)) continue
    const data = isCustom(event, CUSTOM.goalUpdate) ? customValue(event) : event.data
    if (!data || typeof data !== 'object') continue
    const value = data as Record<string, unknown>
    return {
      objective: typeof value.objective === 'string' ? value.objective : '',
      status: typeof value.status === 'string' ? value.status : '',
      tokens_used: typeof value.tokens_used === 'number' ? value.tokens_used : undefined,
      token_budget: typeof value.token_budget === 'number' ? value.token_budget : undefined,
    }
  }
  return null
}

/** Latest snapshot across the conversation, including terminal/cleared goals. */
export function latestGoalFromMessages(
  messages: readonly { events?: InteractionEvent[] }[],
): GoalSnapshot | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const goal = latestGoalFromEvents(messages[index].events ?? [])
    if (goal) return goal
  }
  return null
}
