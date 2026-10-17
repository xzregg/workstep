import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatRoleReference } from '../../api/chatRoles'
import { roleCenterApi, type RoleCatalog } from '../../api/roleCenter'
import { useI18n } from '../../i18n'
import { useOverlay } from '../../hooks/useOverlay'
import { useCompactLayout } from '../../hooks/useCompactLayout'
import ResizablePanel from '../ResizablePanel'
import Button from '../Button'
import Icon from '../Icon'
import Input from '../Input'
import Select from '../Select'
import Spinner from '../Spinner'
import MarkdownMessage from '../MarkdownMessage'

interface Props {
  binding: ChatRoleReference | null; busy: boolean; error: string
  onSelect: (binding: ChatRoleReference) => Promise<boolean>; onClose: () => void
}

export default function RoleAssetPicker({ binding, busy, error, onSelect, onClose }: Props) {
  const { t } = useI18n()
  const panel = useRef<HTMLDivElement>(null)
  const compact = useCompactLayout()
  const [catalog, setCatalog] = useState<RoleCatalog | null>(null)
  const [kind, setKind] = useState<'role' | 'team'>(binding?.kind || 'role')
  const [selected, setSelected] = useState(binding)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [preview, setPreview] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [retry, setRetry] = useState(0)
  const close = () => { if (!busy) onClose() }
  useOverlay(true, close, panel, compact)
  useEffect(() => {
    let active = true
    setLoadError('')
    roleCenterApi.catalog().then(value => { if (active) setCatalog(value) })
      .catch(reason => { if (active) setLoadError(String(reason instanceof Error ? reason.message : reason)) })
    return () => { active = false }
  }, [retry])
  useEffect(() => {
    if (!selected) return
    let active = true
    setLoading(true); setPreview(''); setPreviewError('')
    const load = async () => {
      if (selected.kind === 'role') {
        const role = await roleCenterApi.getRole(selected.id)
        return `## ${role.name}\n\n${role.prompt}`
      }
      const team = await roleCenterApi.getTeam(selected.id)
      const members = await Promise.all(team.members.map(async (member, index) => {
        const role = await roleCenterApi.getRole(member.role_id)
        return `### ${index + 1}. ${role.name}\n\n${member.duty}\n\n${role.prompt}`
      }))
      return [`## ${team.name}`, team.prompt, ...members].join('\n\n')
    }
    load().then(value => { if (active) setPreview(value) })
      .catch(reason => { if (active) setPreviewError(String(reason instanceof Error ? reason.message : reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [selected, retry])
  const records = kind === 'role' ? catalog?.roles || [] : catalog?.teams || []
  const filtered = records.filter(record => (!category || ('category' in record && record.category === category))
    && `${record.name} ${record.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return createPortal(<div className="modal-overlay chat-role-picker-overlay" onMouseDown={event => { if (event.currentTarget === event.target) close() }}>
    <ResizablePanel ref={panel} className="modal chat-role-picker" minWidth={560} minHeight={380} role="dialog" aria-modal="true" aria-label={t('roleCenter.chooseForChat')}>
      <header className="modal-header"><span className="modal-title"><Icon name="drama" /> {t('roleCenter.chooseForChat')}</span>
        <Button variant="icon" aria-label={t('common.close')} onClick={close} disabled={busy}><Icon name="x" /></Button>
      </header>
      <div className="chat-role-picker-filters">
        <div className="chat-role-picker-tabs" role="tablist" aria-label={t('roleCenter.chooseForChat')}>
          {(['role', 'team'] as const).map(value => <button type="button" role="tab" aria-selected={kind === value} key={value} disabled={busy}
            onClick={() => { setKind(value); setCategory(''); setQuery(''); setSelected(null); setPreview(''); setPreviewError(''); setLoading(false) }}>{t(value === 'role' ? 'roleCenter.roles' : 'roleCenter.teams')}</button>)}
        </div>
        <Input value={query} aria-label={t('roleCenter.searchChatAssets')} placeholder={t('roleCenter.searchChatAssets')} onChange={event => setQuery(event.target.value)} />
        {kind === 'role' && <Select value={category} aria-label={t('roleCenter.category')} onChange={event => setCategory(event.target.value)}>
          <option value="">{t('roleCenter.allRoles')}</option>{catalog?.categories.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </Select>}
      </div>
      <div className="chat-role-picker-body">
        <div className="chat-role-picker-list">
          {!catalog && !loadError && <div className="chat-role-picker-loading"><Spinner />{t('roleCenter.loading')}</div>}
          {loadError && <p role="alert">{loadError}</p>}
          {catalog && filtered.length === 0 && <p>{t('roleCenter.empty')}</p>}
          {filtered.map(record => <button type="button" className="chat-role-picker-item" key={record.id} disabled={busy}
            aria-label={t(kind === 'role' ? 'roleCenter.selectRoleLabel' : 'roleCenter.selectTeamLabel', { name: record.name })}
            aria-pressed={selected?.id === record.id && selected.kind === kind} onClick={() => setSelected({ kind, id: record.id })}>
            <strong>{record.name}</strong><span>{record.description}</span>
            {'members' in record && <small>{t('roleCenter.memberCount', { count: record.members.length })}</small>}
          </button>)}
        </div>
        <div className="chat-role-picker-preview">
          {loading ? <div className="chat-role-picker-loading"><Spinner />{t('roleCenter.loading')}</div>
            : previewError ? <p role="alert">{previewError}</p>
            : preview ? <MarkdownMessage content={preview} /> : <p>{t('roleCenter.selectToPreview')}</p>}
        </div>
      </div>
      <footer className="chat-role-picker-footer">
        <div role="alert" className="chat-role-picker-error">{error}</div>
        <p>{t('roleCenter.chatBindingHint')}</p>
        <div>{(loadError || previewError) && <Button onClick={() => setRetry(value => value + 1)}>{t('roleCenter.retry')}</Button>}
          <Button onClick={close} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!selected || !preview || loading || Boolean(previewError || loadError)}
            onClick={() => { if (selected) void onSelect(selected) }}>{t('roleCenter.loadIntoChat')}</Button></div>
      </footer>
    </ResizablePanel>
  </div>, document.body)
}
