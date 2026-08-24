export function assistantStarterPrompt(
  currentTitle: string,
  buildPrompt: (title: string) => string,
): string {
  const title = currentTitle.trim()
  return title ? buildPrompt(title) : ''
}

export function backfillEmptyTitle(currentTitle: string, generatedTitle?: string): string {
  if (currentTitle.trim()) return currentTitle
  return generatedTitle?.trim() || currentTitle
}
