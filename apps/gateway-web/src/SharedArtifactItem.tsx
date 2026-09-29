import { useState } from 'react'

export type SharedArtifact = { id: string; name: string; step_key: string; size: number | null }
type Preview = { type: 'text' | 'image' | 'binary'; content: string; content_type: string }

export function SharedArtifactItem({ base, artifact }: { base: string; artifact: SharedArtifact }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  async function togglePreview() {
    if (open) { setOpen(false); return }
    if (preview) { setOpen(true); return }
    if (busy) return
    setBusy(true)
    setError(false)
    try {
      const response = await fetch(`${base}/artifacts/${artifact.id}/preview`)
      if (!response.ok) { setError(true); return }
      const result = await response.json() as Preview
      setPreview(result)
      setOpen(true)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return <article className="gateway-share-artifact">
    <div className="gateway-share-artifact-header">
      <a href={`${base}/artifacts/${artifact.id}/content`}>{artifact.name}</a>
      {artifact.step_key && <span> · {artifact.step_key}</span>}
      <button type="button" aria-label={`预览 ${artifact.name}`} aria-expanded={open}
        disabled={busy} onClick={() => void togglePreview()}>
        {busy && <span className="gateway-share-spinner" aria-hidden="true" />}
        {open ? '收起预览' : busy ? '正在预览…' : '预览'}
      </button>
    </div>
    {error && <p role="alert">预览暂时不可用，请下载文件查看。</p>}
    {open && preview?.type === 'text' && <pre className="gateway-share-artifact-preview">{preview.content}</pre>}
    {open && preview?.type === 'image' && <img className="gateway-share-artifact-image"
      src={preview.content} alt={artifact.name} />}
    {open && preview?.type === 'binary' && <p>此文件无法直接预览，请下载查看。</p>}
  </article>
}
