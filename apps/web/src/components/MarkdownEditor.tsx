import { useEffect, useRef, useState } from 'react'
import { fsApi } from '../api/client'
import MarkdownMessage from './MarkdownMessage'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  /** Project id — used to upload images and preview `.workstep/uploads/...` paths. */
  projectId?: string
  /** Short id prefix added to uploaded image filenames for later cleanup. */
  imagePrefix?: string
  placeholder?: string
  minHeight?: number | string
  maxHeight?: number | string
  disabled?: boolean
  autoFocus?: boolean
  ariaLabel?: string
}

/**
 * Shared markdown editor: edit/preview toggle, image paste & insert (uploaded to
 * the project's `.workstep/uploads/`, referenced by project-relative path).
 * Reuse for any rich-text field (task descriptions, etc.) — see AGENTS.md.
 */
export default function MarkdownEditor({
  value,
  onChange,
  projectId,
  imagePrefix,
  placeholder = '输入内容…（支持 Markdown，可直接粘贴图片）',
  minHeight = 160,
  maxHeight = '45vh',
  disabled = false,
  autoFocus = false,
  ariaLabel = '任务说明',
}: MarkdownEditorProps) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef(value)
  useEffect(() => {
    valueRef.current = value
  }, [value])

  const insertImageMarkdown = (dataUrl: string, alt = '图片') => {
    const snippet = '![' + alt + '](' + dataUrl + ')'
    const current = valueRef.current
    const ta = textareaRef.current
    if (ta) {
      const start = ta.selectionStart ?? current.length
      const end = ta.selectionEnd ?? current.length
      onChange(current.slice(0, start) + snippet + current.slice(end))
      requestAnimationFrame(() => {
        ta.focus()
        const pos = start + snippet.length
        ta.setSelectionRange(pos, pos)
      })
    } else {
      onChange(current + (current && !current.endsWith('\n') ? '\n' : '') + snippet)
    }
  }

  const handleImageFile = async (file: File) => {
    if (!projectId) return
    const alt = file.name || '图片'
    const placeholderTag = `[img:${Date.now()}]`
    insertImageMarkdown(placeholderTag, alt)
    try {
      const result = await fsApi.uploadImage(file, projectId, imagePrefix)
      onChange(valueRef.current.replace(placeholderTag, result.url))
    } catch (err) {
      // Fallback to base64 if upload fails
      const reader = new FileReader()
      reader.onload = () => {
        onChange(valueRef.current.replace(placeholderTag, String(reader.result)))
      }
      reader.readAsDataURL(file)
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imgItem = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'))
    if (!imgItem || !projectId) return
    e.preventDefault()
    const file = imgItem.getAsFile()
    if (file) handleImageFile(file)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
          <button
            onClick={() => setMode('edit')}
            style={{ padding: '3px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: mode === 'edit' ? 'var(--accent)' : 'transparent', color: mode === 'edit' ? '#fff' : 'var(--fg-2)', fontFamily: 'var(--font-body)' }}
          >编辑</button>
          <button
            onClick={() => setMode('preview')}
            style={{ padding: '3px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: mode === 'preview' ? 'var(--accent)' : 'transparent', color: mode === 'preview' ? '#fff' : 'var(--fg-2)', fontFamily: 'var(--font-body)' }}
          >预览</button>
        </div>
        <button
          className="btn-ghost"
          onClick={() => imgInputRef.current?.click()}
          disabled={!projectId}
          title={projectId ? undefined : '需先选择项目'}
          style={{ fontSize: 12, padding: '3px 8px', gap: 4, opacity: projectId ? 1 : 0.45, cursor: projectId ? 'pointer' : 'not-allowed' }}
        >
          🖼 图片
        </button>
        <span style={{ fontSize: 11, color: 'var(--meta)' }}>支持 Markdown，可粘贴/插入图片</span>
        <input
          ref={imgInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); e.target.value = '' }}
        />
      </div>
      {mode === 'edit' ? (
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onPaste={handlePaste}
          placeholder={placeholder}
          autoFocus={autoFocus}
          style={{ minHeight, maxHeight, resize: 'vertical', fontFamily: 'var(--font-body)', fontSize: 13, boxSizing: 'border-box' }}
        />
      ) : (
        <div style={{
          minHeight, maxHeight, overflowY: 'auto', padding: '10px 12px',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          fontSize: 13, lineHeight: 1.6,
          boxSizing: 'border-box',
        }}>
          {value.trim() ? <MarkdownMessage content={value} projectId={projectId} /> : <span style={{ color: 'var(--meta)', fontStyle: 'italic' }}>暂无内容</span>}
        </div>
      )}
    </div>
  )
}
