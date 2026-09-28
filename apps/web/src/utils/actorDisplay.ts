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
  return author
}

export function displayUserDetail(
  authorName: string | null | undefined,
  deviceName: string | null | undefined,
  fallbackName: string,
  authorUsername?: string | null,
): string {
  const author = authorName?.trim() || fallbackName
  const username = authorUsername?.trim() || ''
  const name = username && username !== author ? `${author} (@${username})` : author
  const device = deviceName?.trim() || ''
  return device ? `${name} · ${device}` : name
}
