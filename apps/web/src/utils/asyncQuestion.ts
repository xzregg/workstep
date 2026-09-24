export interface AsyncQuestion {
  sourceItemId: string
  title: string
  options: string[]
}

interface EventLike {
  type?: string
  name?: string
  value?: Record<string, unknown>
  data?: Record<string, unknown>
}

export function asyncQuestionsFromEvents(events: EventLike[] = []): AsyncQuestion[] {
  const questions: AsyncQuestion[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== 'async_question'
      && !(event.type === 'CUSTOM' && event.name === 'workstep.async_question')) continue
    const value = event.type === 'CUSTOM' ? event.value : event.data
    const sourceItemId = String(value?.source_item_id || '')
    if (!sourceItemId || seen.has(sourceItemId) || !Array.isArray(value?.questions)) continue
    seen.add(sourceItemId)
    for (const question of value.questions) {
      if (!question || typeof question !== 'object') continue
      const candidate = question as Record<string, unknown>
      if (typeof candidate.title !== 'string' || !candidate.title) continue
      questions.push({
        sourceItemId,
        title: candidate.title,
        options: Array.isArray(candidate.options)
          ? candidate.options.filter((option): option is string => typeof option === 'string' && !!option)
          : [],
      })
    }
  }
  return questions
}

export function asyncQuestionAnswer(question: AsyncQuestion, answer: string, questionCount: number): string {
  return questionCount > 1 ? `${question.title}：${answer}` : answer
}
