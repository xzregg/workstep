import { useContext, useState, type DragEvent } from 'react'
import { ComposerOverlayHostContext } from '../hooks/useComposerOverlayClearance'
import { useI18n } from '../i18n'
import Icon from './Icon'
import Textarea from './Textarea'

export interface PendingMessageInsert {
  id: string
  content: string
}

interface PendingMessageInsertsProps {
  items: PendingMessageInsert[]
  title: string
  titleTooltip: string
  editingId?: string | null
  editingContent?: string
  sendingIds?: string[]
  onEditingContentChange?: (value: string) => void
  onEditStart?: (item: PendingMessageInsert) => void
  onEditSave?: (id: string) => void
  onEditCancel?: () => void
  onSend?: (item: PendingMessageInsert) => void
  onRemove?: (id: string) => void
  onSendAll?: () => void
  onClear?: () => void
  /** 拖动排序：fromIndex 为被拖项原下标，toIndex 为移动后在新数组中的下标。不传则禁用拖动。 */
  onReorder?: (fromIndex: number, toIndex: number) => void
  /** 拖动排序的提示文案（拖拽手柄 title）。 */
  reorderHint?: string
}

export default function PendingMessageInserts({
  items,
  title,
  titleTooltip,
  editingId,
  editingContent = '',
  sendingIds = [],
  onEditingContentChange,
  onEditStart,
  onEditSave,
  onEditCancel,
  onSend,
  onRemove,
  onSendAll,
  onClear,
  onReorder,
  reorderHint,
}: PendingMessageInsertsProps) {
  const { t } = useI18n()
  // 会话区宿主（若有）会测量面板高度，给会话内容留出底部空间。
  const registerOverlay = useContext(ComposerOverlayHostContext)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  if (items.length === 0) return null

  const sending = new Set(sendingIds)
  const allSending = items.every((item) => sending.has(item.id))
  const reorderable = Boolean(onReorder) && items.length > 1 && sendingIds.length === 0

  const handleDragStart = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
    setDragIndex(index)
    setDropIndex(null)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>, index: number) => {
    if (dragIndex === null || index === dragIndex) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropIndex !== index) setDropIndex(index)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    if (dragIndex === null) return
    event.preventDefault()
    event.stopPropagation()
    const from = dragIndex
    const rect = event.currentTarget.getBoundingClientRect()
    const before = event.clientY < rect.top + rect.height / 2
    // toIndex 为移动后在新数组中的下标
    const to = from < index
      ? (before ? index - 1 : index)
      : (before ? index : index + 1)
    setDragIndex(null)
    setDropIndex(null)
    if (from === index || to === from) return
    onReorder?.(from, to)
  }

  const handleDragEnd = () => {
    setDragIndex(null)
    setDropIndex(null)
  }

  return (
    <div
      ref={registerOverlay ?? undefined}
      role="region"
      aria-label={title}
      aria-live="polite"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'calc(100% - 40px)',
        maxWidth: 900,
        marginBottom: 6,
        zIndex: 30,
        borderRadius: 8,
        border: '1px solid var(--border-soft)',
        background: 'var(--bg)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
        padding: '6px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        title={titleTooltip}
        style={{
          fontSize: 'calc(11px * var(--font-scale))',
          fontWeight: 600,
          color: 'var(--meta)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {title}
        <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
          {t('taskDetail.itemCount', { count: items.length })}
        </span>
        {reorderable && reorderHint && (
          <span style={{ fontWeight: 400, color: 'var(--muted)', opacity: 0.8 }}>
            {reorderHint}
          </span>
        )}
      </div>

      {items.map((item, index) => {
        const isEditing = editingId === item.id
        const isSending = sending.has(item.id)
        const isDragging = dragIndex === index
        const isDropTarget = dropIndex === index && dragIndex !== null && dragIndex !== index
        return (
          <div
            key={item.id}
            draggable={reorderable && !isEditing}
            onDragStart={reorderable && !isEditing
              ? (event) => handleDragStart(event, index)
              : undefined}
            onDragOver={reorderable ? (event) => handleDragOver(event, index) : undefined}
            onDrop={reorderable ? (event) => handleDrop(event, index) : undefined}
            onDragEnd={reorderable ? handleDragEnd : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 6px',
              borderRadius: 6,
              opacity: isSending ? 0.65 : isDragging ? 0.45 : 1,
              cursor: reorderable && !isEditing
                ? (isDragging ? 'grabbing' : 'grab')
                : 'default',
              background: isDropTarget ? 'var(--accent-light)' : undefined,
              outline: isDropTarget ? '1px dashed var(--accent)' : undefined,
              outlineOffset: -1,
            }}
          >
            {isEditing ? (
              <Textarea
                autoFocus
                value={editingContent}
                onChange={(event) => onEditingContentChange?.(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    onEditSave?.(item.id)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    onEditCancel?.()
                  }
                }}
                rows={2}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 'calc(11px * var(--font-scale))',
                  lineHeight: 1.4,
                  color: 'var(--fg)',
                  background: 'var(--bg)',
                  border: '1px solid var(--accent)',
                  borderRadius: 6,
                  padding: '4px 6px',
                  outline: 'none',
                  resize: 'none',
                  fontFamily: 'var(--font-body)',
                }}
              />
            ) : (
              <>
                {isSending ? (
                  <span className="task-status-spinner" aria-hidden="true" />
                ) : (
                  <Icon
                    name={reorderable ? 'grip-vertical' : 'list'}
                    size={12}
                    strokeWidth={1.6}
                    color={reorderable ? 'var(--meta)' : 'var(--muted)'}
                    style={{
                      flexShrink: 0,
                      opacity: reorderable ? 0.85 : 0.7,
                      cursor: reorderable ? 'grab' : 'default',
                    }}
                  />
                )}
                <div
                  title={item.content}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 'calc(13px * var(--font-scale))',
                    lineHeight: 1.4,
                    color: 'var(--fg)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {item.content}
                </div>
              </>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              {isEditing ? (
                <>
                  <button
                    type="button"
                    onClick={() => onEditSave?.(item.id)}
                    disabled={!editingContent.trim()}
                    title={t('taskDetail.saveEditTitle')}
                    style={{
                      padding: '2px 8px',
                      borderRadius: 6,
                      fontSize: 'calc(11px * var(--font-scale))',
                      border: 'none',
                      background: 'var(--accent)',
                      color: 'var(--accent-fg)',
                      cursor: editingContent.trim() ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {t('common.save')}
                  </button>
                  <button
                    type="button"
                    onClick={onEditCancel}
                    title={t('taskDetail.cancelEditTitle')}
                    style={{
                      padding: '2px 8px',
                      borderRadius: 6,
                      fontSize: 'calc(11px * var(--font-scale))',
                      border: '1px solid var(--border)',
                      background: 'transparent',
                      color: 'var(--meta)',
                      cursor: 'pointer',
                    }}
                  >
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onSend?.(item)}
                    disabled={isSending}
                    title={t('taskDetail.sendInsertTitle')}
                    style={{
                      padding: '2px 6px',
                      fontSize: 'calc(11px * var(--font-scale))',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--accent)',
                      cursor: isSending ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {t('chatInput.send')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onEditStart?.(item)}
                    disabled={isSending}
                    title={t('taskDetail.editInsertTitle')}
                    style={{
                      padding: 4,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--muted)',
                      cursor: isSending ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      borderRadius: 4,
                    }}
                  >
                    <Icon name="pencil" size={12} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove?.(item.id)}
                    disabled={isSending}
                    title={t('taskDetail.deleteInsertTitle')}
                    style={{
                      padding: 4,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--muted)',
                      cursor: isSending ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      borderRadius: 4,
                    }}
                  >
                    <Icon name="trash" size={12} strokeWidth={2} />
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}

      {items.length > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 6,
            paddingTop: 4,
            borderTop: '1px solid var(--border-soft)',
          }}
        >
          <button
            type="button"
            onClick={onSendAll}
            disabled={sendingIds.length > 0}
            title={t('taskDetail.sendAllTitle')}
            style={{
              padding: '2px 8px',
              fontSize: 'calc(11px * var(--font-scale))',
              borderRadius: 6,
              border: 'none',
              background: 'var(--accent)',
              color: 'var(--accent-fg)',
              cursor: sendingIds.length > 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {allSending ? t('chatInput.generating') : t('taskDetail.sendAll', { count: items.length })}
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={sendingIds.length > 0}
            title={t('taskDetail.clearAllTitle')}
            style={{
              padding: '2px 8px',
              fontSize: 'calc(11px * var(--font-scale))',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--meta)',
              cursor: sendingIds.length > 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {t('taskDetail.clearAll')}
          </button>
        </div>
      )}
    </div>
  )
}
