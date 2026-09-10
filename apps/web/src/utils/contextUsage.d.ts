export interface ContextUsage {
  used: number
  total: number
  percent: number
  estimated?: boolean
  breakdown?: {
    system: number
    toolDefinitions: number
    user: number
    assistant: number
    toolRequests: number
    toolResults: number
    visible: number
    other: number
    estimated: boolean
  }
  tools?: Array<{ name: string; tokens: number }>
}

export interface ContextUsageMessage {
  events?: unknown[]
}

export function usageFromEvents(events: unknown[]): Record<string, unknown> | null

export function contextUsageFromMessages(
  messages: ContextUsageMessage[],
): ContextUsage | null

export function estimateTokens(text: string): number

export function estimateUsageFromEvents(
  events: unknown[],
): Record<string, unknown> | null
