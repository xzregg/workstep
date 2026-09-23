import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fsApi, type DirectoryEntry } from '../api/client'
import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'

export interface BrowserActionTarget {
  entry: DirectoryEntry
  parentPath: string
  x: number
  y: number
  isRoot?: boolean
}

type Action = 'newFile' | 'newFolder' | 'rename' | 'delete'

interface Props {
  projectId: string
  rootPath?: string
  target: BrowserActionTarget | null
  onDismiss: () => void
  onPreview: (entry: DirectoryEntry) => void
  onBeforeAction: (action: () => void) => void
  onChanged: () => void
}

export default function ProjectDirectoryTreeActions({
  projectId, rootPath, target, onDismiss, onPreview, onBeforeAction, onChanged,
}: Props) {
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement>(null)
  const [action, setAction] = useState<{ type: Action; target: BrowserActionTarget } | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!target) return
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onDismiss()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [target, onDismiss])

  const begin = (type: Action) => {
    if (!target) return
    const selected = target
    onDismiss()
    onBeforeAction(() => {
      setAction({ type, target: selected })
      setName(type === 'rename' ? selected.entry.name : '')
      setError('')
    })
  }

  const commit = async () => {
    if (!action || busy) return
    setBusy(true)
    setError('')
    try {
      const entry = action.target.entry
      if (action.type === 'newFile' || action.type === 'newFolder') {
        await fsApi.createEntry(
          projectId, rootPath, entry.path, name,
          action.type === 'newFile' ? 'file' : 'directory',
        )
      } else if (action.type === 'rename') {
        await fsApi.renameEntry(projectId, rootPath, entry.path, name)
      } else {
        await fsApi.deleteEntry(projectId, rootPath, entry.path)
      }
      setAction(null)
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const title = action ? t(`browser.${action.type}`) : ''
  const invalidName = !name.trim() || name === '.' || name === '..'
    || name.includes('/') || name.includes('\\') || name.includes('\0')
  return createPortal(
    <>
      {target && (
        <div
          ref={menuRef}
          className="project-directory-context-menu"
          role="menu"
          aria-label={t('browser.fileActions')}
          style={{
            left: Math.max(8, Math.min(target.x, window.innerWidth - 180)),
            top: Math.max(8, Math.min(target.y, window.innerHeight - 180)),
          }}
        >
          {target.entry.type === 'directory' ? (
            <>
              <button type="button" role="menuitem" onClick={() => begin('newFolder')}>{t('browser.newDirectory')}</button>
              <button type="button" role="menuitem" onClick={() => begin('newFile')}>{t('browser.newFile')}</button>
            </>
          ) : (
            <button type="button" role="menuitem" onClick={() => { onDismiss(); onBeforeAction(() => onPreview(target.entry)) }}>
              {t('browser.previewFile')}
            </button>
          )}
          {!target.isRoot && (
            <>
              <button type="button" role="menuitem" onClick={() => begin('rename')}>{t('browser.rename')}</button>
              <button type="button" role="menuitem" className="project-directory-danger" onClick={() => begin('delete')}>
                {t('browser.delete')}
              </button>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(action)}
        title={title}
        message={action?.type === 'delete' ? t('browser.deleteConfirm', { name: action.target.entry.name }) : undefined}
        confirmText={action?.type === 'delete' ? t('browser.delete') : undefined}
        danger={action?.type === 'delete'}
        loading={busy}
        confirmDisabled={action?.type !== 'delete' && invalidName}
        zIndex={2300}
        onCancel={() => { if (!busy) setAction(null) }}
        onConfirm={() => void commit()}
      >
        {action?.type !== 'delete' && (
          <label className="project-directory-action-field">
            <span>{t('browser.entryName')}</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !invalidName) void commit() }} />
          </label>
        )}
        {error && <div className="project-directory-editor-error" role="alert">{error}</div>}
      </ConfirmDialog>
    </>,
    document.body,
  )
}
