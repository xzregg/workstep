/** Artifact Preview Component - Displays file contents based on type. */

import { useState, useEffect } from 'react'
import { fsApi, type FilePreview } from '../api/client'

interface ArtifactPreviewProps {
  path: string
  onClose?: () => void
}

export default function ArtifactPreview({ path, onClose }: ArtifactPreviewProps) {
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    fsApi.preview(path)
      .then((data) => {
        if (active) setPreview(data)
      })
      .catch((e) => {
        if (active) {
          setError(e instanceof Error ? e.message : 'Failed to load artifact')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [path])

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--meta)' }}>
        加载中...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }}>
        加载失败: {error}
        {onClose && (
          <button className="btn-ghost" style={{ marginTop: 12 }} onClick={onClose}>
            关闭
          </button>
        )}
      </div>
    )
  }

  if (!preview) {
    return null
  }

  const { type, content_type, content, extension = '' } = preview
  const isImage = type === 'image'
  const isText = type === 'text'
  const isCode = isText && ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'h', 'json', 'md', 'html', 'css'].includes(extension.slice(1))

  if (isImage) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {onClose && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button className="btn-ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        )}
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', borderRadius: 8 }}>
          <img
            src={content}
            alt="Artifact"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--meta)' }}>
          {content_type} | {(content.length / 1024).toFixed(2)} KB
        </div>
      </div>
    )
  }

  if (isCode) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-2)' }}>
            {extension} 文件
          </div>
          {onClose && (
            <button className="btn-ghost" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
        <div style={{ flex: 1, overflow: 'auto', background: 'var(--surface)', borderRadius: 8 }}>
          <pre style={{ padding: 16, margin: 0, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {content}
          </pre>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--meta)' }}>
          {content_type} | {(content.length / 1024).toFixed(2)} KB
        </div>
      </div>
    )
  }

  // Default text preview
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg-2)' }}>
          {extension || '文件'} 预览
        </div>
        {onClose && (
          <button className="btn-ghost" onClick={onClose}>
            关闭
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto', background: 'var(--surface)', borderRadius: 8, padding: 16 }}>
        <pre style={{ margin: 0, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {content}
        </pre>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--meta)' }}>
        {content_type} | {(content.length / 1024).toFixed(2)} KB
      </div>
    </div>
  )
}
