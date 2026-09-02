export interface ContextUsage {
  used: number
  total: number
  percent: number
}

export interface ContextUsageMessage {
  events?: unknown[]
}

export function usageFromEvents(events: unknown[]): Record<string, unknown> | null

export function contextUsageFromMessages(
  messages: ContextUsageMessage[],
): ContextUsage | null
