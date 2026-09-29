import { useState } from 'react'

type EventPage = { events: Record<string, unknown>[]; next_cursor: number | null }

export function SharedMessageEvents({ base, messageId }: { base: string; messageId: string }) {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<Record<string, unknown>[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  async function load(cursor: number) {
    if (busy) return
    setBusy(true)
    setError(false)
    try {
      const response = await fetch(`${base}/events/${encodeURIComponent(messageId)}/${cursor}`)
      if (!response.ok) { setError(true); return }
      const page = await response.json() as EventPage
      setEvents(current => cursor === 0 ? page.events : [...current, ...page.events])
      setNextCursor(page.next_cursor)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  function toggle() {
    if (open) { setOpen(false); return }
    setOpen(true)
    if (nextCursor === 0) void load(0)
  }

  return <div className="gateway-share-events">
    <button type="button" onClick={toggle}>{open ? '收起过程' : '查看过程'}</button>
    {open && <div>
      {error && <p>过程暂时不可用，请重试。</p>}
      {events.length === 0 && !busy && !error && <p>暂无过程事件。</p>}
      {events.map((event, index) => <pre key={index}>{JSON.stringify(event, null, 2)}</pre>)}
      {nextCursor !== null && <button type="button" disabled={busy}
        onClick={() => void load(nextCursor)}>
        {busy && <span className="gateway-share-spinner" aria-hidden="true" />}
        {busy ? '正在加载…' : error ? '重试' : '加载更多过程'}
      </button>}
    </div>}
  </div>
}
