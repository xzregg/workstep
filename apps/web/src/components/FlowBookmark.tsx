import { createContext, useContext, useRef, useState, type ChangeEvent, type CompositionEvent } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'
import { NodeResizer, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'
import './FlowBookmark.css'

export interface CanvasBookmark {
  id: string
  title?: string
  text: string
  width?: number
  height?: number
  position: { x: number; y: number }
}

export const BookmarkContext = createContext({ readOnly: false, onChange: () => {} })

interface BookmarkFieldProps {
  multiline?: boolean
  label: string
  placeholder: string
  value: string
  readOnly: boolean
  onCommit: (value: string) => void
}

function BookmarkField({
  multiline,
  label,
  placeholder,
  value,
  readOnly,
  onCommit,
}: BookmarkFieldProps) {
  const composingRef = useRef(false)
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? value
  const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = event.currentTarget.value
    if (composingRef.current) {
      setDraft(next)
      return
    }
    if (draft !== null) setDraft(null)
    onCommit(next)
  }
  const handleCompositionStart = (event: CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    composingRef.current = true
    setDraft(event.currentTarget.value)
  }
  const handleCompositionEnd = (event: CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    composingRef.current = false
    setDraft(null)
    onCommit(event.currentTarget.value)
  }
  const common = {
    className: 'nodrag',
    'aria-label': label,
    placeholder,
    value: shown,
    readOnly,
    onChange: handleChange,
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
  }
  return multiline ? <textarea {...common} /> : <input {...common} />
}

export function loadBookmarks(steps: { bookmarks?: CanvasBookmark[] } | null | undefined): Node[] {
  return (steps?.bookmarks || []).map(bookmark => ({
    id: `bookmark:${bookmark.id}`, type: 'bookmark', position: bookmark.position,
    connectable: false,
    width: bookmark.width ?? 260, height: bookmark.height ?? 190,
    data: { bookmarkId: bookmark.id, title: bookmark.title || '', text: bookmark.text, nodeId: 0 },
  }))
}

export function saveBookmarks(nodes: Node[]): CanvasBookmark[] {
  return nodes.filter(node => node.type === 'bookmark').map(node => ({
    id: String(node.data.bookmarkId), title: String(node.data.title || ''),
    text: String(node.data.text || ''), position: node.position,
    width: node.width ?? 260, height: node.height ?? 190,
  }))
}

export default function FlowBookmark({ id, data, selected }: NodeProps) {
  const { t } = useI18n()
  const { readOnly, onChange } = useContext(BookmarkContext)
  const { updateNodeData, deleteElements } = useReactFlow()
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <>
    <NodeResizer isVisible={selected && !readOnly} minWidth={160} minHeight={100} color="#94700c" onResizeEnd={onChange} />
    <div className={`flow-bookmark${selected ? ' is-selected' : ''}`}>
      <div className="flow-bookmark-header">
        <BookmarkField label={t('flow.bookmarkTitle')} placeholder={t('flow.bookmarkTitlePlaceholder')}
          value={String(data.title || '')} readOnly={readOnly}
          onCommit={(title) => {
            updateNodeData(id, { title })
            onChange()
          }} />
        {!readOnly && <button type="button" className="nodrag" aria-label={t('flow.deleteBookmark')} onClick={() => setConfirmDelete(true)}>
          <Trash2 size={14} aria-hidden="true" />
        </button>}
      </div>
      <BookmarkField multiline label={t('flow.bookmarkNote')} placeholder={t('flow.bookmarkPlaceholder')}
        value={String(data.text || '')} readOnly={readOnly}
        onCommit={(text) => {
          updateNodeData(id, { text })
          onChange()
        }} />
      {createPortal(<ConfirmDialog danger open={confirmDelete} title={t('flow.deleteBookmark')} onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { void deleteElements({ nodes: [{ id }] }); onChange(); setConfirmDelete(false) }} />, document.body)}
    </div>
    </>
  )
}
