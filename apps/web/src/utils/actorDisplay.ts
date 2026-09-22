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
): string {
  const author = authorName?.trim() || ''
  if (!author || isSameActorName(author, currentUserName)) return meLabel
  return author
}

export function displayUserDetail(
  authorName: string | null | undefined,
  deviceName: string | null | undefined,
  fallbackName: string,
): string {
  const author = authorName?.trim() || fallbackName
  const device = deviceName?.trim() || ''
  return device ? `${author} · ${device}` : author
}
