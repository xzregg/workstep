import { useRef, useState } from 'react'

export function PlatformAddress({address}: {address: string | null}) {
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  async function copy() {
    if (!address || pending.current) return
    pending.current = true; setBusy(true); setStatus('')
    try { await navigator.clipboard.writeText(address); setStatus('地址已复制') }
    catch { setStatus('复制失败，请选中地址手动复制。') }
    finally { pending.current = false; setBusy(false) }
  }
  return <div>
    <div className="gateway-platform-address"><code>{address ?? '未配置'}</code>
      {address && <button type="button" disabled={busy} onClick={() => void copy()}>复制地址</button>}
    </div>
    {status && <p role="status">{status}</p>}
  </div>
}
