import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { digitalPersonApi, type DigitalPersonProfile } from '../../api/digitalPerson'
import { roleCenterApi } from '../../api/roleCenter'
import { useProjectStore } from '../../stores/projectStore'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Input from '../Input'
import Select from '../Select'
import Spinner from '../Spinner'
import ConfirmDialog from '../ConfirmDialog'
import RoleAssetPicker from '../role-center/RoleAssetPicker'
import DigitalPersonAvatar from './DigitalPersonAvatar'
import DigitalPersonVoice from './DigitalPersonVoice'
import BotSettings from '../../pages/BotSettings'
import SchedulePage from '../../pages/SchedulePage'
import AgentAssistantSettings from '../../pages/AgentAssistantSettings'
import { DIGITAL_PERSON_CHANGED } from './useDigitalPerson'
import './DigitalPersonSettings.css'

type Tab = 'card' | 'identity' | 'appearance' | 'proactive' | 'channels' | 'memory' | 'assistant'
const tabs: Tab[] = ['card', 'identity', 'appearance', 'proactive', 'channels', 'memory', 'assistant']
export default function DigitalPersonSettings({ onClose, onDirtyChange }: { onClose: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n(), navigate = useNavigate()
  const projects = useProjectStore(state => state.projects)
  const workspace = projects.find(project => project.type !== 'remote' && project.is_default_workspace)
  const [saved, setSaved] = useState<DigitalPersonProfile | null>(null)
  const [draft, setDraft] = useState<DigitalPersonProfile | null>(null)
  const [tab, setTab] = useState<Tab>('card')
  const [pendingTab, setPendingTab] = useState<Tab | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true), [retry, setRetry] = useState(0)
  const [childDirty, setChildDirty] = useState(false)
  const [chooseRole, setChooseRole] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  const profileDirty = JSON.stringify(saved) !== JSON.stringify(draft)
  const dirty = profileDirty || childDirty || busy
  const childChanged = useCallback((value: boolean) => setChildDirty(value), [])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    digitalPersonApi.get().then(value => { if (active) { setSaved(value); setDraft(value) } })
      .catch(reason => { if (active) setError(String(reason instanceof Error ? reason.message : reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [retry])
  const switchTab = (next: Tab) => {
    if (next === tab || busy) return
    if (dirty) setPendingTab(next)
    else setTab(next)
  }
  const update = <K extends keyof DigitalPersonProfile>(key: K, value: DigitalPersonProfile[K]) => setDraft(current => current && ({ ...current, [key]: value }))
  const valid = Boolean(draft?.name.trim() && draft.duties.trim())
  const save = async (value = draft) => {
    if (!value || busy) return
    setBusy(true); setError('')
    try { const result = await digitalPersonApi.save(value); setSaved(result); setDraft(result); window.dispatchEvent(new Event(DIGITAL_PERSON_CHANGED)); setOnboarding(false); setTab('card') }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)) }
    finally { setBusy(false) }
  }
  const openChat = () => {
    if (!workspace) return
    useProjectStore.getState().setActiveProject(workspace)
    navigate(`/chat?project=${encodeURIComponent(workspace.name)}`); onClose()
  }
  if (loading) return <div className="digital-person-loading"><Spinner />{t('digitalPerson.loading')}</div>
  if (!draft || !saved) return <div role="alert">{error}<Button onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</Button></div>
  return <div className="digital-person-settings">
    <header className="digital-person-header"><h1>{t('digitalPerson.title')}</h1>
      {(tab === 'identity' || tab === 'appearance') && <Button variant="primary" disabled={!valid || (!profileDirty && !onboarding)} loading={busy}
        onClick={() => void save(onboarding ? { ...draft, enabled: true } : draft)}>{t(onboarding ? 'digitalPerson.finish' : 'common.save')}</Button>}
    </header>
    {error && <p role="alert" className="digital-person-error">{error}</p>}
    <nav className="digital-person-tabs" aria-label={t('digitalPerson.title')}>
      {tabs.map(value => <Button key={value} aria-current={tab === value ? 'page' : undefined} disabled={busy}
        onClick={() => switchTab(value)}>{t(`digitalPerson.${value}`)}</Button>)}
    </nav>
    {tab === 'card' && <article className="digital-person-card">
      <div className="digital-person-card-main"><DigitalPersonAvatar avatar={saved.avatar} /><div><h2>{saved.name}</h2><p className="digital-person-role">{saved.role}</p><p>{saved.personality}</p><span className="digital-person-status">{t(saved.enabled ? 'digitalPerson.enabled' : 'digitalPerson.disabled')}</span></div></div>
      <p className="digital-person-duties">{saved.duties}</p>
      <div className="digital-person-actions"><Button variant="primary" disabled={!workspace} onClick={openChat}>{t('digitalPerson.chat')}</Button>
        <Button onClick={() => setTab('identity')}>{t('digitalPerson.edit')}</Button>
        <Button loading={busy} onClick={() => {
          if (saved.enabled) void save({ ...saved, enabled: false })
          else { setOnboarding(true); setTab('identity') }
        }}>{t(saved.enabled ? 'digitalPerson.disable' : 'digitalPerson.enable')}</Button></div>
    </article>}
    {tab === 'identity' && <div className="digital-person-form">
      {onboarding && <h2>{t('digitalPerson.onboarding')}</h2>}
      <label>{t('digitalPerson.name')}<Input name="name" maxLength={80} value={draft.name} disabled={busy} onChange={event => update('name', event.target.value)} /></label>
      <label>{t('digitalPerson.role')}<Input maxLength={200} value={draft.role} disabled={busy} onChange={event => update('role', event.target.value)} /></label>
      <Button disabled={busy} onClick={() => setChooseRole(true)}>{t('digitalPerson.chooseRole')}</Button>
      <label>{t('digitalPerson.personality')}<textarea maxLength={2000} value={draft.personality} disabled={busy} onChange={event => update('personality', event.target.value)} /></label>
      <label>{t('digitalPerson.duties')}<textarea maxLength={8000} value={draft.duties} disabled={busy} onChange={event => update('duties', event.target.value)} /></label>
      <label>{t('digitalPerson.greeting')}<Input maxLength={500} value={draft.greeting} disabled={busy} onChange={event => update('greeting', event.target.value)} /></label>
    </div>}
    {tab === 'appearance' && <div className="digital-person-form">
      <label>{t('digitalPerson.avatar')}<Select value={draft.avatar} disabled={busy} onChange={event => update('avatar', event.target.value as DigitalPersonProfile['avatar'])}>
        <option value="robot">{t('digitalPerson.robot')}</option><option value="spark">{t('digitalPerson.spark')}</option></Select></label>
      <DigitalPersonVoice profile={draft} />
    </div>}
    {tab === 'memory' && <div className="digital-person-memory"><p>{t('digitalPerson.memoryPreview')}</p>
      <iframe title={t('digitalPerson.memory')} src={`${(import.meta.env?.BASE_URL || '/')}digital-person/human-brain.html`} sandbox="allow-scripts" />
    </div>}
    {tab === 'proactive' && <div className="digital-person-schedules">{workspace ? <SchedulePage defaultTargetType="session" project={workspace} onClose={onClose} onEditorStateChange={state => childChanged(state.dirty)} /> : <p>{t('digitalPerson.noWorkspace')}</p>}</div>}
    {tab === 'channels' && <BotSettings onDirtyChange={childChanged} />}
    {tab === 'assistant' && <AgentAssistantSettings />}
    <ConfirmDialog open={pendingTab !== null} title={t('digitalPerson.discard')} onCancel={() => setPendingTab(null)} onConfirm={() => {
      setDraft(saved); setChildDirty(false); setOnboarding(false); setTab(pendingTab!); setPendingTab(null)
    }} />
    {chooseRole && <RoleAssetPicker binding={null} busy={busy} error={error} onClose={() => setChooseRole(false)} onSelect={async reference => {
      setBusy(true); setError('')
      try {
        if (reference.kind === 'role') {
          const role = await roleCenterApi.getRole(reference.id)
          if (role.prompt.length > 8000) throw new Error(t('digitalPerson.roleTooLong'))
          setDraft(current => current && ({ ...current, role: role.name, duties: role.prompt }))
        } else {
          const team = await roleCenterApi.getTeam(reference.id)
          const members = await Promise.all(team.members.map(member => roleCenterApi.getRole(member.role_id)))
          const duties = [team.prompt, ...members.map((member, index) => `${member.name}\n${team.members[index].duty}\n${member.prompt}`)].join('\n\n')
          if (duties.length > 8000) throw new Error(t('digitalPerson.roleTooLong'))
          setDraft(current => current && ({ ...current, role: team.name, duties }))
        }
        setChooseRole(false); return true
      } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); return false }
      finally { setBusy(false) }
    }} />}
  </div>
}
