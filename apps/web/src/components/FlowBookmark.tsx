import { createContext, useContext, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'
import { NodeResizer, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'
import './FlowBookmark.css'

export interface CanvasBookmark {
  id: string
  text: string
  width?: number
  height?: number
  position: { x: number; y: number }
}

export const BookmarkContext = createContext({ readOnly: false, onChange: () => {} })

export function loadBookmarks(steps: { bookmarks?: CanvasBookmark[] } | null | undefined): Node[] {
  return (steps?.bookmarks || []).map(bookmark => ({
    id: `bookmark:${bookmark.id}`, type: 'bookmark', position: bookmark.position,
    connectable: false,
    width: bookmark.width ?? 260, height: bookmark.height ?? 190,
    data: { bookmarkId: bookmark.id, text: bookmark.text, nodeId: 0 },
  }))
}

export function saveBookmarks(nodes: Node[]): CanvasBookmark[] {
  return nodes.filter(node => node.type === 'bookmark').map(node => ({
    id: String(node.data.bookmarkId), text: String(node.data.text || ''), position: node.position,
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
        {!readOnly && <button type="button" className="nodrag" aria-label={t('flow.deleteBookmark')} onClick={() => setConfirmDelete(true)}>
          <Trash2 size={14} aria-hidden="true" />
        </button>}
      </div>
      <textarea className="nodrag nowheel" aria-label={t('flow.bookmarkNote')}
        placeholder={t('flow.bookmarkPlaceholder')} value={String(data.text || '')} readOnly={readOnly}
        onChange={event => {
          if (readOnly) return
          updateNodeData(id, { text: event.target.value })
          onChange()
        }}
      />
      {createPortal(<ConfirmDialog danger open={confirmDelete} title={t('flow.deleteBookmark')} onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { void deleteElements({ nodes: [{ id }] }); onChange(); setConfirmDelete(false) }} />, document.body)}
    </div>
    </>
  )
}
