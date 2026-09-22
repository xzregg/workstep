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
