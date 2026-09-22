export function applyAssistantQuickPrompt(currentValue, prompt) {
  const current = currentValue.trim()
  return current ? `${current}\n${prompt}` : prompt
}

export const applyTaskQuickPrompt = applyAssistantQuickPrompt
