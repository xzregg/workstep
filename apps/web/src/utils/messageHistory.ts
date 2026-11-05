/** Shared default and bounds for visible conversation history pages. */
export const DEFAULT_MESSAGE_HISTORY_PAGE_SIZE = 20
export const MAX_MESSAGE_HISTORY_PAGE_SIZE = 300

export function validMessageHistoryPageSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= 1 && value <= MAX_MESSAGE_HISTORY_PAGE_SIZE
}
