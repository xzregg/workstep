import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import MarkdownMessage from './MarkdownMessage'
import { MarkdownTextEditContext } from '../contexts/MarkdownTextEditContext'
import './MarkdownPreviewEditor.css'

/** Replace only the edited prose; leave image URLs and all untouched Markdown bytes intact. */
function encodeText(text: string) {
  return text.replace(/[&\\`*_{}[\]<>()#!|~+\-.=]/g, char => `&#${char.charCodeAt(0)};`).replace(/\r\n?/g, '\n').replace(/\n/g, '  \n')
}

export default function MarkdownPreviewEditor({ value, onChange, projectId, readOnly, label, id, maxLength, onPaste }: {
  value: string
  onChange: (value: string) => void
  projectId?: string
  readOnly: boolean
  label: string
  id?: string
  maxLength?: number
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
}) {
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const patches = useRef(new Map<number, { end: number; text: string }>())
  const lastEmitted = useRef(value)
  useEffect(() => {
    // Upload completion or an external draft reset invalidates the old source offsets.
    if (snapshot !== null && value !== lastEmitted.current) {
      patches.current.clear()
      setSnapshot(value)
      lastEmitted.current = value
    }
  }, [value, snapshot])
  const source = snapshot ?? value
  return <div id={id} className="markdown-preview-editor" onPasteCapture={onPaste}
    onClickCapture={event => {
      const target = event.target as HTMLElement
      const text = target.closest<HTMLElement>('[contenteditable="true"]')
      if (text) {
        event.stopPropagation()
        if (target.closest('a')) {
          event.preventDefault()
          text.focus()
        }
      }
    }}
    onFocusCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        patches.current.clear()
        lastEmitted.current = value
        setSnapshot(value)
      }
    }}
    onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSnapshot(null)
    }}>
    <MarkdownTextEditContext.Provider value={readOnly ? null : { label, replace(start, end, text) {
      const previous = patches.current.get(start)
      patches.current.set(start, { end, text: encodeText(text) })
      let next = source
      for (const [offset, patch] of [...patches.current].sort((a, b) => b[0] - a[0])) {
        const prefix = offset === source.length && offset > 0 ? '\n\n' : ''
        next = next.slice(0, offset) + prefix + patch.text + next.slice(patch.end)
      }
      if (maxLength !== undefined && next.length > maxLength) {
        if (previous) patches.current.set(start, previous)
        else patches.current.delete(start)
        return false
      }
      lastEmitted.current = next
      onChange(next)
      return true
    } }}>
      <MarkdownMessage content={source} projectId={projectId} reveal="off" editableText={!readOnly} />
    </MarkdownTextEditContext.Provider>
  </div>
}
