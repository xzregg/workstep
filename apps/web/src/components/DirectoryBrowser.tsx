import { useState, useEffect } from 'react'
import Button from './Button'
import { useI18n } from '../i18n'
import { fsApi, type DirectoryBrowseResult, type DirectoryEntry } from '../api/client'

interface Props {
  onSelect: (path: string) => void
  initialPath?: string
}

export default function DirectoryBrowser({ onSelect, initialPath }: Props) {
  const { t } = useI18n()
  const [current, setCurrent] = useState<DirectoryBrowseResult | null>(null)
  const [loading, setLoading] = useState(false)

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

  const handleSelect = () => {
    if (current?.path) {
      onSelect(current.path)
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
          variant="primary"
          onClick={handleSelect}
          style={{ fontSize: 11, padding: '4px 10px' }}
          disabled={!current}
        >
          {t('browser.selectDir')}
        </Button>
      </div>

      {/* File list */}
      <div style={{
        maxHeight: 300, overflowY: 'auto',
        padding: 4,
      }}>
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
            onDoubleClick={() => handleDoubleClick(entry)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px',
              borderRadius: 6,
              cursor: entry.type === 'directory' ? 'pointer' : 'default',
              fontSize: 13,
              color: entry.type === 'directory' ? 'var(--fg)' : 'var(--muted)',
              transition: 'background var(--motion-fast)',
            }}
            onMouseEnter={(e) => { if (entry.type === 'directory') e.currentTarget.style.background = 'var(--surface)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
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
