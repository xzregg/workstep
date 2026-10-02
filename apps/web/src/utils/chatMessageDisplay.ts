import { buildMessageTimeline, timelineText, type MessageTimelineEvent } from './messageTimeline'

/**
 * 失败消息可能把错误写入正文，同时 error 又负责渲染红色错误行；两者完全相同时
 * 隐藏正文，避免同一原因出现两次。「（生成失败：原因）」的历史包装也视为同一原因。
 */
export function visibleAssistantContent(content: string, error?: string): string {
  const normalizedContent = content.trim()
  const normalizedError = error?.trim()
  if (!normalizedContent || !normalizedError) return content

  const contentCandidates = [
    normalizedContent,
    normalizedContent
      .replace(/^（生成失败：/, '')
      .replace(/）$/, '')
      .trim(),
  ]
  return contentCandidates.includes(normalizedError) ? '' : content
}

/** 只被覆盖成「（生成失败：…）」包装文案的 content：没有真实正文，需要兜底重建。 */
export function isWrappedFailureContent(content: string): boolean {
  const body = (content ?? '').trim()
  return body !== '' && /^（生成失败：[\s\S]*）$/.test(body)
}

/**
 * 正文兜底重建：当正文为空、或只被覆盖成包装错误文案（「（生成失败：…）」）时，
 * 从事件流里的 final_answer 正文（type:'text'，不含 commentary）重建正文，用于
 * 正文被失败/压缩吞掉的历史消息。正文本身有效（非空且非纯包装错误）时返回 ''，
 * 不触发重建，保持既有助手消息的渲染不变。
 */
export function assistantBodyFallback(
  content: string,
  events: MessageTimelineEvent[] | null | undefined,
): string {
  const body = (content ?? '').trim()
  if (body && !isWrappedFailureContent(content)) return ''
  if (!events || events.length === 0) return ''
  return timelineText(buildMessageTimeline(events))
}
