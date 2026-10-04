function authorDisplayName(authorName: string): string {
  return authorName.replace(/^(?:企业微信|钉钉)\s*·\s*(?=\S)/, '')
}

export function isSameActorName(
  authorName?: string | null,
  currentUserName?: string | null,
): boolean {
  const author = authorName?.trim() || ''
  const current = currentUserName?.trim() || ''
  return Boolean(author && current && author === current)
}

export function displayUserSender(
  authorName: string | null | undefined,
  currentUserName: string | null | undefined,
  meLabel: string,
  historicalUserLabel: string,
): string {
  const author = authorName?.trim() || ''
  if (!author) return historicalUserLabel
  if (isSameActorName(author, currentUserName)) return meLabel
  return authorDisplayName(author)
}

export function displayUserDetail(
  authorName: string | null | undefined,
  deviceName: string | null | undefined,
  fallbackName: string,
  authorUsername?: string | null,
): string {
  const author = authorDisplayName(authorName?.trim() || fallbackName)
  const authorParts = author.split('·').map((part) => part.trim())
  const username = authorUsername?.trim() || ''
  const name = username && !authorParts.includes(username) ? `${author} (@${username})` : author
  const device = deviceName?.trim() || ''
  return device && !authorParts.includes(device) ? `${name} · ${device}` : name
}
