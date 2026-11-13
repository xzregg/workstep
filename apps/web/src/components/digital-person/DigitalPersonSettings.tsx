import DigitalPersonGrowth from './DigitalPersonGrowth'
import DigitalPersonMemory from './DigitalPersonMemory'
import DigitalPersonTraitField from './DigitalPersonTraitField'
import { useCallback, useEffect, useState } from 'react'
import { digitalPersonApi, type DigitalPersonProfile } from '../../api/digitalPerson'
import { useCompactLayout } from '../../hooks/useCompactLayout'
import { roleCenterApi } from '../../api/roleCenter'
import { useProjectStore } from '../../stores/projectStore'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Input from '../Input'
import Select from '../Select'
import Spinner from '../Spinner'
import ConfirmDialog from '../ConfirmDialog'
import RoleAssetPicker from '../role-center/RoleAssetPicker'
import DigitalPersonActivity from './DigitalPersonActivity'
import DigitalPersonAvatar from './DigitalPersonAvatar'
import DigitalPersonVoice from './DigitalPersonVoice'
import AssistantEngineSettings from '../AssistantEngineSettings'
import DigitalPersonChatButton from './DigitalPersonChatButton'
import DigitalPersonChannels from './DigitalPersonChannels'
import { DIGITAL_PERSON_CHANGED } from './useDigitalPerson'
import './DigitalPersonSettings.css'

type Tab = 'card' | 'identity' | 'appearance' | 'proactive' | 'channels' | 'memory' | 'assistant' | 'activity'
const tabs: Tab[] = ['card', 'identity', 'appearance', 'proactive', 'channels', 'memory', 'assistant', 'activity']
export default function DigitalPersonSettings({ onClose, onDirtyChange }: { onClose: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n()
  const compact = useCompactLayout()
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
  const [guide, setGuide] = useState<number | null>(null)
  const guideTabs: Tab[] = ['identity', 'appearance', 'assistant', 'proactive', 'channels', 'card']
  const beginGuide = () => { setGuide(0); setTab('identity') }
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
    else { setGuide(null); setTab(next) }
  }
  const update = <K extends keyof DigitalPersonProfile>(key: K, value: DigitalPersonProfile[K]) => setDraft(current => current && ({ ...current, [key]: value }))
  const interval = draft?.proactive_interval_minutes ?? 30
  const valid = Boolean(draft?.name.trim() && draft.duties.trim() && Number.isInteger(interval) && interval >= 1 && interval <= 1440 && [draft.quiet_start ?? 22,draft.quiet_end ?? 8].every(v=>Number.isInteger(v)&&v>=0&&v<=23) && (draft.voice_rate ?? 1)>=.5 && (draft.voice_rate ?? 1)<=2)
  const save = async (value = draft) => {
    if (!value || busy) return false
    setBusy(true); setError('')
    try { const result = await digitalPersonApi.save(value); setSaved(result); setDraft(result); window.dispatchEvent(new Event(DIGITAL_PERSON_CHANGED)); if(guide===null)setTab('card'); return true }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); return false }
    finally { setBusy(false) }
  }
  const toggleEnabled = async () => {
    if (!saved || busy) return
    if (!saved.enabled && !saved.onboarding_completed) { beginGuide(); return }
    setBusy(true); setError('')
    try {
      const result = await digitalPersonApi.save({ ...saved, enabled: !saved.enabled })
      setSaved(result); setDraft(current => current && ({ ...current, enabled: result.enabled }))
      window.dispatchEvent(new Event(DIGITAL_PERSON_CHANGED))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  if (loading) return <div className="digital-person-loading"><Spinner />{t('digitalPerson.loading')}</div>
  if (!draft || !saved) return <div role="alert">{error}<Button onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</Button></div>
  return <div className="digital-person-settings">
    <header className="digital-person-header"><h1>{t('digitalPerson.title')}</h1>
      <div className="digital-person-header-actions">
        {busy && <Spinner />}
        <span className="digital-person-status">{t(saved.enabled ? 'digitalPerson.enabled' : 'digitalPerson.disabled')}</span>
        <button type="button" className="settings-switch" role="switch" aria-label={t('digitalPerson.title')}
          aria-checked={saved.enabled} disabled={busy} onClick={() => void toggleEnabled()}><span className="settings-switch-thumb" /></button>
      </div>
    </header>
    {error && <p role="alert" className="digital-person-error">{error}</p>}
    {guide !== null && <div className="digital-person-guide"><strong>{t('digitalPerson.setupStep',{step:guide+1,total:guideTabs.length})}</strong><span>{t(`digitalPerson.${guideTabs[guide]}`)}</span>
      <Button disabled={busy} onClick={()=>setGuide(null)}>{t('digitalPerson.setupLater')}</Button>
      <Button disabled={busy || childDirty || !valid} onClick={async()=>{
        const next=guide+1
        const done=next===guideTabs.length
        if(profileDirty || done){if(!await save({...draft, ...(done?{enabled:true,onboarding_completed:true}:{})}))return}
        if(done){setGuide(null);setTab('card')}else{setGuide(next);setTab(guideTabs[next])}
      }}>{t(guide===guideTabs.length-1?'digitalPerson.finishSetup':'digitalPerson.nextStep')}</Button></div>}
    <div className="digital-person-settings-body">
    <nav className="digital-person-tabs" role="tablist" aria-orientation={compact ? 'horizontal' : 'vertical'} aria-label={t('digitalPerson.title')}>
      {tabs.map((value, index) => <button type="button" key={value} id={`digital-person-tab-${value}`} role="tab"
        aria-selected={tab === value} aria-controls="digital-person-panel" tabIndex={tab === value ? 0 : -1} disabled={busy}
        onKeyDown={event => {
          const direction = (event.key === 'ArrowRight' || event.key === 'ArrowDown') ? 1 : (event.key === 'ArrowLeft' || event.key === 'ArrowUp') ? -1 : 0
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : direction ? (index + direction + tabs.length) % tabs.length : -1
          if (next < 0) return
          event.preventDefault(); document.getElementById(`digital-person-tab-${tabs[next]}`)?.focus()
        }} onClick={() => switchTab(value)}>{t(`digitalPerson.${value}`)}</button>)}
    </nav>
    <section id="digital-person-panel" role="tabpanel" aria-labelledby={`digital-person-tab-${tab}`}>
    {(['identity', 'appearance', 'proactive'] as Tab[]).includes(tab) && <div className="digital-person-form-actions"><Button variant="primary" disabled={!valid || !profileDirty} loading={busy}
      onClick={() => void save()}>{t('common.save')}</Button></div>}
    {tab === 'card' && <article className="digital-person-card">
      <div className="digital-person-card-main"><DigitalPersonAvatar avatar={saved.avatar} /><div><h2>{saved.name}</h2><p className="digital-person-role">{saved.role}</p><p>{[saved.personality,saved.tone].filter(Boolean).join('，')}</p><span className="digital-person-status">{t(saved.enabled ? 'digitalPerson.enabled' : 'digitalPerson.disabled')}</span></div></div>
      <DigitalPersonGrowth /><details className="digital-person-card-details"><summary>{t('digitalPerson.duties')}</summary><p className="digital-person-duties">{saved.duties}</p></details>
      <div className="digital-person-actions"><DigitalPersonChatButton workspace={workspace} onClose={onClose} />
        <Button onClick={() => setTab('identity')}>{t('digitalPerson.edit')}</Button><Button onClick={beginGuide}>{t('digitalPerson.setup')}</Button>
      </div>
    </article>}
    {tab === 'identity' && <div className="digital-person-form">
      <label>{t('digitalPerson.name')}<Input name="name" maxLength={80} value={draft.name} disabled={busy} onChange={event => update('name', event.target.value)} /></label>
      <DigitalPersonTraitField name="role" label={t('digitalPerson.identityLabel')} value={draft.role} maxLength={200} disabled={busy}
        presets={['rd','assistant','manager','study','creative','life'].map(key=>t(`digitalPerson.rolePreset${key}` as never))}
        onChange={role=>setDraft(current=>current && ({...current,role,role_binding:null}))}/>
      <Button disabled={busy} onClick={() => setChooseRole(true)}>{t('digitalPerson.chooseRole')}</Button>
      <DigitalPersonTraitField name="personality" label={t('digitalPerson.personality')} value={draft.personality} maxLength={2000} disabled={busy} multiline
        presets={['rigorous','curious','patient','proactive','rational','optimistic'].map(key=>t(`digitalPerson.personalityPreset${key}` as never))} onChange={value=>update('personality',value)}/>
      <DigitalPersonTraitField name="tone" label={t('digitalPerson.tone')} value={draft.tone ?? ''} maxLength={1000} disabled={busy}
        presets={['direct','warm','professional','humorous','supportive','detailed'].map(key=>t(`digitalPerson.tonePreset${key}` as never))} onChange={value=>update('tone',value)}/>
      <label>{t('digitalPerson.duties')}<textarea maxLength={8000} value={draft.duties} disabled={busy} onChange={event => setDraft(current=>current && ({...current,duties:event.target.value,role_binding:null}))} /></label>
      <label>{t('digitalPerson.greeting')}<Input maxLength={500} value={draft.greeting} disabled={busy} onChange={event => update('greeting', event.target.value)} /></label>
    </div>}
    {tab === 'appearance' && <div className="digital-person-form digital-person-appearance-form">
      <label>{t('digitalPerson.avatar')}<Select value={draft.avatar} disabled={busy} onChange={event => update('avatar', event.target.value as DigitalPersonProfile['avatar'])}>
        <option value="robot">{t('digitalPerson.robot')}</option><option value="spark">{t('digitalPerson.spark')}</option></Select></label>
      <label>{t('digitalPerson.voiceRate')}<Input type="number" min={.5} max={2} step={.1} value={draft.voice_rate ?? 1} onChange={e=>update('voice_rate',Number(e.target.value))}/></label>
      <label className="digital-person-channel-check"><input type="checkbox" checked={draft.auto_speak ?? false} onChange={e=>update('auto_speak',e.target.checked)}/>{t('digitalPerson.autoSpeak')}</label>
      <label className="digital-person-channel-check"><input type="checkbox" checked={draft.show_panel ?? true} onChange={e=>update('show_panel',e.target.checked)}/>{t('digitalPerson.showPanel')}</label>
      <label className="digital-person-channel-check"><input type="checkbox" checked={draft.floating ?? false} onChange={e=>update('floating',e.target.checked)}/>{t('digitalPerson.showFloating')}</label>
      <DigitalPersonVoice profile={draft} onChange={patch=>setDraft(current=>current && ({...current,...patch}))} />
    </div>}
    {tab === 'memory' && <DigitalPersonMemory name={saved.name} avatar={saved.avatar} />}
    {tab === 'activity' && <DigitalPersonActivity onNavigate={onClose} />}
    {tab === 'proactive' && <div className="digital-person-form">
      <label className="digital-person-channel-check"><input type="checkbox" checked={draft.proactive_enabled ?? false} onChange={e=>update('proactive_enabled',e.target.checked)}/>{t('digitalPerson.enableProactive')}</label>
      <label>{t('digitalPerson.checkInstruction')}<textarea value={draft.proactive_instruction ?? ''} onChange={e=>update('proactive_instruction',e.target.value)} maxLength={4000}/></label>
      <label>{t('digitalPerson.checkInterval')}<Input name="proactive_interval_minutes" type="number" min={1} max={1440} step={1}
        value={draft.proactive_interval_minutes ?? 30} disabled={busy} onChange={event => update('proactive_interval_minutes', Number(event.target.value))} /></label>
      <div className="digital-person-field-pair"><label>{t('digitalPerson.quietStart')}<Input type="number" min={0} max={23} value={draft.quiet_start ?? 22} onChange={e=>update('quiet_start',Number(e.target.value))}/></label>
      <label>{t('digitalPerson.quietEnd')}<Input type="number" min={0} max={23} value={draft.quiet_end ?? 8} onChange={e=>update('quiet_end',Number(e.target.value))}/></label></div>
      <Button onClick={()=>switchTab('activity')}>{t('digitalPerson.checkNow')}</Button>
    </div>}
    {tab === 'channels' && <DigitalPersonChannels workspaceId={workspace?.id} name={saved.name} onDirtyChange={childChanged} />}
    {tab === 'assistant' && <AssistantEngineSettings assistantName="digital_person" onDirtyChange={childChanged} />}
    </section>
    </div>
    <ConfirmDialog open={pendingTab !== null} title={t('digitalPerson.discard')} onCancel={() => setPendingTab(null)} onConfirm={() => {
      setDraft(saved); setChildDirty(false); setGuide(null); setTab(pendingTab!); setPendingTab(null)
    }} />
    {chooseRole && <RoleAssetPicker binding={null} busy={busy} error={error} onClose={() => setChooseRole(false)} onSelect={async reference => {
      setBusy(true); setError('')
      try {
        if (reference.kind === 'role') {
          const role = await roleCenterApi.getRole(reference.id)
          if (role.prompt.length > 8000) throw new Error(t('digitalPerson.roleTooLong'))
          setDraft(current => current && ({ ...current, role: role.name, duties: role.prompt, role_binding: reference }))
        } else {
          const team = await roleCenterApi.getTeam(reference.id)
          const members = await Promise.all(team.members.map(member => roleCenterApi.getRole(member.role_id)))
          const duties = [team.prompt, ...members.map((member, index) => `${member.name}\n${team.members[index].duty}\n${member.prompt}`)].join('\n\n')
          if (duties.length > 8000) throw new Error(t('digitalPerson.roleTooLong'))
          setDraft(current => current && ({ ...current, role: team.name, duties, role_binding: reference }))
        }
        setChooseRole(false); return true
      } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); return false }
      finally { setBusy(false) }
    }} />}
  </div>
}
