import type { ReactNode } from 'react'

const attachment = /(!?)\[((?:\\.|[^\]])*)\]\(\.workstep\/uploads\/(t[0-9a-f]{24}-[0-9a-f]{32}\.[a-z0-9]{1,10})\)/g

export function SharedMessageContent({ base, content }: { base: string; content: string }) {
  const parts: ReactNode[] = []
  let cursor = 0
  for (const match of content.matchAll(attachment)) {
    const index = match.index ?? 0
    if (index > cursor) parts.push(content.slice(cursor, index))
    const label = match[2].replace(/\\([\\\[\]()])/g, '$1')
    const url = `${base}/uploads/${match[3]}`
    parts.push(match[1]
      ? <img className="gateway-share-message-image" src={url} alt={label} key={index} loading="lazy" />
      : <a href={url} key={index} target="_blank" rel="noreferrer">{label}</a>)
    cursor = index + match[0].length
  }
  if (cursor < content.length) parts.push(content.slice(cursor))
  return <div className="gateway-share-message-content">{parts}</div>
}
