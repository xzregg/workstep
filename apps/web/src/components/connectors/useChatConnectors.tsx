import { useEffect, useState } from 'react'
import { connectorApi, CONNECTORS_CHANGED, type AvailableConnector } from '../../api/connectors'
import { useI18n } from '../../i18n'
import Icon from '../Icon'
import ConnectorPicker from './ConnectorPicker'
import ComposerContextChip from '../ComposerContextChip'

/** Owns session selection; the composer only places its controls. */
export function useChatConnectors({ enabled, projectId, sessionId, engineId, locked, value, onChange }: {
  enabled: boolean; projectId?: string; sessionId?: string; engineId: string; locked: boolean; value: string; onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const [items, setItems] = useState<AvailableConnector[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const active = Boolean(enabled && projectId && sessionId)
  useEffect(() => {
    let current = true
    setItems([]); setOpen(false); setError('')
    if (!active) return
    let pending = false, queued = false
    const refresh = () => {
      if (pending) { queued = true; return }
      pending = true
      setLoading(true); setError('')
      void connectorApi.available(projectId!, sessionId!, engineId)
        .then(result => { if (!Array.isArray(result.connectors)) throw new Error(t('connectors.unavailable')); if (current) setItems(result.connectors) })
        .catch(reason => { if (current) setError(String(reason.message || reason)) })
        .finally(() => {
          pending = false
          if (current) {
            setLoading(false)
            if (queued) { queued = false; refresh() }
          }
        })
    }
    refresh()
    window.addEventListener(CONNECTORS_CHANGED, refresh)
    return () => { current = false; window.removeEventListener(CONNECTORS_CHANGED, refresh) }
  }, [active, projectId, sessionId, engineId])
  useEffect(() => {
    if (active && !locked && /^\/(连接器|apps)\s*$/.test(value)) {
      setOpen(true); onChange('')
    }
  }, [active, locked, value, onChange])
  const selected = items.filter(item => item.selected)
  const remove = async (id: string) => {
    setSaving(true); setError('')
    const updated = items.map(item => item.id === id ? { ...item, selected: false } : item)
    try {
      await connectorApi.select(projectId!, sessionId!, updated.filter(item => item.selected).map(item => item.id))
      setItems(updated)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }
  return {
    active,
    hasSelection: active && selected.length > 0,
    blocked: active && (loading || saving || selected.some(item => !item.available)),
    open: () => { if (!locked) setOpen(true) },
    tags: active && (selected.length > 0 || error) ? <div className="connector-tags">
      {selected.map(item => <ComposerContextChip key={item.id} className="connector-tag" name={item.name}
        icon={<Icon name="plug" size={14} />} unavailable={!item.available} disabled={locked || saving}
        onRemove={() => void remove(item.id)} removeLabel={`${t('connectors.remove')} ${item.name}`} />)}
      {error && <span role="alert" className="connector-error">{error}</span>}
    </div> : null,
    control: active ? <div className="connector-toolbar-anchor">
      {open && !locked && <ConnectorPicker projectId={projectId!} sessionId={sessionId!} engineId={engineId} initialItems={items} onClose={() => setOpen(false)} onChanged={setItems} onSavingChange={setSaving} />}
    </div> : null,
  }
}
