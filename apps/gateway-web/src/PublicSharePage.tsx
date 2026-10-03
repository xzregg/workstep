import { useEffect } from 'react'

const openCanonicalViewer = () => window.location.reload()

/** A portal SPA navigation must reload the server-owned WorkStep viewer entry. */
export function PublicSharePage({ openViewer = openCanonicalViewer }: { openViewer?: () => void }) {
  useEffect(() => { openViewer() }, [openViewer])
  return <p role="status">正在打开任务详情…</p>
}
