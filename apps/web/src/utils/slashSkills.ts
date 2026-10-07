export interface SlashInputSelection {
  value: string
  cursor: number
}

export interface SlashInputItemLike {
  insert_text: string
}

function slashRange(value: string, cursor: number): { start: number; query: string } | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length))
  if (value[safeCursor - 1] !== '/') return null
  return {
    start: safeCursor - 1,
    query: '',
  }
}

export function slashInputQuery(value: string, cursor: number): string | null {
  return slashRange(value, cursor)?.query ?? null
}

export function applySlashInputItem(
  value: string,
  cursor: number,
  item: SlashInputItemLike,
): SlashInputSelection {
  const range = slashRange(value, cursor)
  if (!range) return { value, cursor }
  const insertion = item.insert_text
  const nextValue = `${value.slice(0, range.start)}${insertion}${value.slice(cursor)}`
  return {
    value: nextValue,
    cursor: range.start + insertion.length,
  }
}
