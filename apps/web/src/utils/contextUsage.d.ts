export interface ContextUsage {
  used: number
  total: number
  percent: number
}

export interface ContextUsageMessage {
  events?: unknown[]
}

export const FALLBACK_CONTEXT_WINDOW: number

export function usageFromEvents(events: unknown[]): Record<string, unknown> | null

export function contextUsageFromMessages(
  messages: ContextUsageMessage[],
): ContextUsage | null
