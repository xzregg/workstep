import { useEffect, useState } from 'react'
import { connectorApi, openConnectorSettings, type AvailableConnector } from '../../api/connectors'
import { useI18n } from '../../i18n'
import ResponsivePopover from '../ResponsivePopover'
import Icon from '../Icon'
import './Connectors.css'

export default function ConnectorPicker({ projectId, sessionId, engineId, initialItems, onClose, onChanged, onSavingChange }: {
  projectId: string; sessionId: string; engineId: string; initialItems?: AvailableConnector[]; onClose: () => void; onChanged?: (items: AvailableConnector[]) => void; onSavingChange?: (saving: boolean) => void
}) {
  const { t } = useI18n()
  const [items, setItems] = useState<AvailableConnector[]>(initialItems || [])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(!initialItems)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (initialItems) { setItems(initialItems); setLoading(false); return }
    let active = true
    setLoading(true); setError('')
    void connectorApi.available(projectId, sessionId, engineId).then(result => { if (!Array.isArray(result.connectors)) throw new Error(t('connectors.unavailable')); if (active) setItems(result.connectors) })
      .catch(reason => { if (active) setError(String(reason.message || reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectId, sessionId, engineId, initialItems])
  const toggle = async (id: string) => {
    const updated = items.map(item => item.id === id ? { ...item, selected: !item.selected } : item)
    setSaving(true); onSavingChange?.(true); setError('')
    try {
      await connectorApi.select(projectId, sessionId, updated.filter(item => item.selected).map(item => item.id))
      setItems(updated); onChanged?.(updated)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false); onSavingChange?.(false) }
  }
  return <ResponsivePopover title={t('connectors.title')} onClose={onClose} className="connector-picker-popover">
    <div className="connector-picker-content">
      <label className="connector-search"><Icon name="search" size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('connectors.search')} aria-label={t('connectors.search')} /></label>
      <div className="connector-picker-list">
        {loading && <span className="connector-loading"><span className="task-status-spinner" />{t('connectors.loading')}</span>}
        {error && <p className="connector-error" role="alert">{error}</p>}
        {!loading && !items.length && <p className="connector-muted">{t('connectors.empty')}</p>}
        {items.filter(item => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <div className="connector-picker-row" key={item.id}>
          <span className="connector-glyph"><Icon name={item.kind === 'cli' ? 'terminal' : 'plug'} size={20} /></span>
          <span className="connector-picker-copy"><strong>{item.name}</strong><small>{item.description}</small></span>
          <button type="button" role="switch" aria-checked={item.selected} aria-label={item.name}
            title={!item.available ? t('connectors.unavailable') : item.name} disabled={!item.available || saving}
            className="connector-switch" onClick={() => void toggle(item.id)}><span /></button>
        </div>)}
      </div>
      <footer className="connector-picker-footer"><button type="button" onClick={() => { onClose(); openConnectorSettings() }}>{t('connectors.manage')}</button></footer>
    </div>
  </ResponsivePopover>
}
