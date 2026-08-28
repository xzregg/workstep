import { useState, useEffect } from 'react'
import Button from './Button'
import Input from './Input'
import { useI18n } from '../i18n'
import { fsApi, type DirectoryBrowseResult, type DirectoryEntry } from '../api/client'

interface Props {
  onSelect: (path: string) => void
  selectedPath?: string
  initialPath?: string
}

export default function DirectoryBrowser({ onSelect, selectedPath, initialPath }: Props) {
  const { t } = useI18n()
  const [current, setCurrent] = useState<DirectoryBrowseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [creatingBusy, setCreatingBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const browse = async (path?: string) => {
    setLoading(true)
    try {
      const data = await fsApi.browse(path)
      setCurrent(data)
    } catch (e) {
      console.error('Browse failed:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    browse(initialPath)
  }, [initialPath])

  const handleDoubleClick = (entry: DirectoryEntry) => {
    if (entry.type === 'directory') {
      browse(entry.path)
    }
  }

  const handleGoUp = () => {
    if (current?.parent) {
      browse(current.parent)
    }
  }

  const resetCreate = () => {
    setCreating(false)
    setNewName('')
    setCreateError(null)
  }

  const handleCreate = async () => {
    if (!current) return
    const name = newName.trim()
    if (!name) return
    if (/[\s/\\]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
      setCreateError(t('browser.folderNameInvalid'))
      return
    }
    setCreatingBusy(true)
    setCreateError(null)
    try {
      await fsApi.mkdir(current.path, name)
      resetCreate()
      await browse(current.path)
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : t('browser.createFolderFailed'))
    } finally {
      setCreatingBusy(false)
    }
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      {/* Breadcrumb bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border-soft)',
        fontSize: 13, color: 'var(--fg-2)',
      }}>
        <Button
          variant="icon"
          onClick={handleGoUp}
          disabled={!current?.parent}
          style={{ width: 24, height: 24 }}
        >
          ↑
        </Button>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
          {current?.path || t('common.loading')}
        </span>
        <Button
          variant="ghost"
          onClick={() => setCreating(true)}
          disabled={!current}
          style={{ fontSize: 11, padding: '4px 10px' }}
        >
          ＋ {t('browser.newFolder')}
        </Button>
      </div>

      {/* Create-folder row */}
      {creating && (
        <div style={{
          padding: '8px 12px',
          background: 'var(--bg)',
          borderBottom: '1px solid var(--border-soft)',
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              autoFocus
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setCreateError(null) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate()
                if (e.key === 'Escape') resetCreate()
              }}
              placeholder={t('browser.folderName')}
              style={{ flex: 1, height: 28, fontSize: 13 }}
            />
            <Button
              variant="primary"
              loading={creatingBusy}
              disabled={!newName.trim()}
              onClick={() => void handleCreate()}
              style={{ fontSize: 11, padding: '4px 10px' }}
            >
              {t('browser.createFolder')}
            </Button>
            <Button
              variant="ghost"
              onClick={resetCreate}
              style={{ fontSize: 11, padding: '4px 10px' }}
            >
              {t('common.cancel')}
            </Button>
          </div>
          {createError && (
            <div style={{ marginTop: 6, color: 'var(--danger)', fontSize: 12 }}>
              {createError}
            </div>
          )}
        </div>
      )}

      {/* File list */}
      <div style={{
        maxHeight: 300, overflowY: 'auto',
        padding: 4,
      }} role="listbox" aria-label={t('browser.directoryList')}>
        {loading && (
          <div style={{ padding: 12, textAlign: 'center', color: 'var(--meta)', fontSize: 13 }}>
            {t('common.loading')}
          </div>
        )}
        {!loading && current?.entries.length === 0 && (
          <div style={{ padding: 12, textAlign: 'center', color: 'var(--meta)', fontSize: 13 }}>
            {t('browser.emptyDir')}
          </div>
        )}
        {!loading && current?.entries.map((entry) => (
          <div
            key={entry.path}
            role={entry.type === 'directory' ? 'option' : undefined}
            aria-selected={entry.type === 'directory' ? selectedPath === entry.path : undefined}
            tabIndex={entry.type === 'directory' ? 0 : undefined}
            onClick={entry.type === 'directory' ? () => onSelect(entry.path) : undefined}
            onDoubleClick={() => handleDoubleClick(entry)}
            onKeyDown={(event) => {
              if (entry.type !== 'directory') return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(entry.path)
              }
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px',
              borderRadius: 6,
              cursor: entry.type === 'directory' ? 'pointer' : 'default',
              fontSize: 13,
              color: selectedPath === entry.path ? 'var(--accent-fg)' : entry.type === 'directory' ? 'var(--fg)' : 'var(--muted)',
              background: selectedPath === entry.path ? 'var(--accent)' : 'transparent',
              transition: 'background var(--motion-fast)',
            }}
            onMouseEnter={(e) => { if (entry.type === 'directory' && selectedPath !== entry.path) e.currentTarget.style.background = 'var(--surface)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = selectedPath === entry.path ? 'var(--accent)' : 'transparent' }}
          >
            <span style={{ fontSize: 13 }}>
              {entry.type === 'directory' ? '📁' : '📄'}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
