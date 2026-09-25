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
      className="pending-insert-panel"
    >
      <div
        title={titleTooltip}
        className="pending-insert-heading"
      >
        {title}
        <span className="pending-insert-heading-detail">
          {t('taskDetail.itemCount', { count: items.length })}
        </span>
        {reorderable && reorderHint && (
          <span className="pending-insert-heading-detail pending-insert-reorder-hint">
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
            className="pending-insert-row"
            data-sending={isSending || undefined}
            data-dragging={isDragging || undefined}
            data-drop-target={isDropTarget || undefined}
            data-reorderable={reorderable && !isEditing || undefined}
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
                className="pending-insert-editor"
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
                    className={`pending-insert-icon${reorderable ? ' is-reorderable' : ''}`}
                  />
                )}
                <div
                  title={item.content}
                  className="pending-insert-content"
                >
                  {item.content}
                </div>
              </>
            )}

            <div className="pending-insert-actions">
              {isEditing ? (
                <>
                  <button
                    type="button"
                    onClick={() => onEditSave?.(item.id)}
                    disabled={!editingContent.trim()}
                    title={t('taskDetail.saveEditTitle')}
                    className="pending-insert-button pending-insert-button--primary"
                  >
                    {t('common.save')}
                  </button>
                  <button
                    type="button"
                    onClick={onEditCancel}
                    title={t('taskDetail.cancelEditTitle')}
                    className="pending-insert-button pending-insert-button--outline"
                  >
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <>
                  {onSend && (
                    <button
                      type="button"
                      onClick={() => onSend(item)}
                      disabled={isSending}
                      title={t('taskDetail.sendInsertTitle')}
                      className="pending-insert-button pending-insert-button--send"
                    >
                      {t('chatInput.send')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onEditStart?.(item)}
                    disabled={isSending}
                    title={t('taskDetail.editInsertTitle')}
                    className="pending-insert-button pending-insert-button--icon"
                  >
                    <Icon name="pencil" size={12} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove?.(item.id)}
                    disabled={isSending}
                    title={t('taskDetail.deleteInsertTitle')}
                    className="pending-insert-button pending-insert-button--icon"
                  >
                    <Icon name="trash" size={12} strokeWidth={2} />
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}

      {items.length > 1 && (onSendAll || onClear) && (
        <div className="pending-insert-footer">
          {onSendAll && (
            <button
              type="button"
              onClick={onSendAll}
              disabled={sendingIds.length > 0}
              title={t('taskDetail.sendAllTitle')}
              className="pending-insert-button pending-insert-button--primary"
            >
              {allSending ? t('chatInput.generating') : t('taskDetail.sendAll', { count: items.length })}
            </button>
          )}
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              disabled={sendingIds.length > 0}
              title={t('taskDetail.clearAllTitle')}
              className="pending-insert-button pending-insert-button--outline"
            >
              {t('taskDetail.clearAll')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
