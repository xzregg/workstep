import { useNavigate } from 'react-router-dom'
import DigitalPersonRelationship from './DigitalPersonRelationship'
import DigitalPersonOperations from './DigitalPersonOperations'
import DigitalPersonCamera from './DigitalPersonCamera'
import DigitalPersonGrowth from './DigitalPersonGrowth'
import DigitalPersonMemory from './DigitalPersonMemory'
import DigitalPersonTraitField from './DigitalPersonTraitField'
import DigitalPersonBodyNavigation, { type DigitalPersonBodyPart } from './DigitalPersonBodyNavigation'
import VoiceWakeSettings from './VoiceWakeSettings'
import { useCallback, useEffect, useRef, useState } from 'react'
import { digitalPersonApi, digitalRuntimeApi, type DigitalPersonProfile } from '../../api/digitalPerson'
import { roleCenterApi } from '../../api/roleCenter'
import { useProjectStore } from '../../stores/projectStore'
import { useI18n } from '../../i18n'
import { useCompactLayout } from '../../hooks/useCompactLayout'
import Button from '../Button'
import Input from '../Input'
import Select from '../Select'
import Spinner from '../Spinner'
import ConfirmDialog from '../ConfirmDialog'
import RoleAssetPicker from '../role-center/RoleAssetPicker'
import DigitalPersonActivity from './DigitalPersonActivity'
import DigitalPersonAvatar from './DigitalPersonAvatar'
import VoiceOutputSettings from '../VoiceOutputSettings'
import AssistantEngineSettings from '../AssistantEngineSettings'
import DigitalPersonChatButton from './DigitalPersonChatButton'
import DigitalPersonChannels from './DigitalPersonChannels'
import { DIGITAL_PERSON_CHANGED } from './useDigitalPerson'
import { DIGITAL_ACTIVITY_CHANGED } from './useDigitalActivity'
import './DigitalPersonSettings.css'

type Tab = 'card' | 'identity' | 'appearance' | 'proactive' | 'channels' | 'memory' | 'assistant' | 'activity' | 'input' | 'vision' | 'tools'
const bodyTabs: Record<DigitalPersonBodyPart, Tab> = { brain: 'assistant', eyes: 'vision', ears: 'input', mouth: 'appearance', heart: 'proactive', hands: 'tools', feet: 'activity' }
const auxiliaryTabs = ['card', 'identity', 'channels', 'activity'] as const
export default function DigitalPersonSettings({ onClose, onDirtyChange, onBusyChange }: { onClose: () => void; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void }) {
  const { t } = useI18n()
  const compactLayout = useCompactLayout()
  const navigate = useNavigate()
  const enterHome = () => { onDirtyChange?.(false); onClose(); navigate('/companion') }
  const projects = useProjectStore(state => state.projects)
  const workspace = projects.find(project => project.type !== 'remote' && project.is_default_workspace)
  const [saved, setSaved] = useState<DigitalPersonProfile | null>(null)
  const [draft, setDraft] = useState<DigitalPersonProfile | null>(null)
  const [tab, setTab] = useState<Tab>('card')
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (tab !== 'card' && window.matchMedia('(max-width: 1023px)').matches) {
      const panel = panelRef.current
      const content = panel?.closest<HTMLElement>('.settings-content')
      if (panel && content) {
        content.scrollTo({top: content.scrollTop + panel.getBoundingClientRect().top - content.getBoundingClientRect().top - 16, behavior: 'instant'})
      } else panel?.scrollIntoView?.({block: 'start', behavior: 'auto'})
    }
  }, [tab])
  const [pendingTab, setPendingTab] = useState<Tab | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true), [retry, setRetry] = useState(0)
  const [childDirty, setChildDirty] = useState(false)
  const [childBusy, setChildBusy] = useState(false)
  const [pendingToggle, setPendingToggle] = useState(false)
  const blocked = busy || childBusy
  const childBusyChanged = useCallback((value: boolean) => setChildBusy(value), [])
  const [chooseRole, setChooseRole] = useState(false)
  const [guide, setGuide] = useState<number | null>(null)
  const guideTabs = ['identity', 'appearance', 'assistant', 'proactive', 'channels', 'card'] as const
  const beginGuide = () => { setGuide(0); setTab('identity') }
  const profileDirty = JSON.stringify(saved) !== JSON.stringify(draft)
  const dirty = profileDirty || childDirty || busy
  const childChanged = useCallback((value: boolean) => setChildDirty(value), [])
  const voiceSaved = useCallback((profile: DigitalPersonProfile) => {
    const voice = { voice_name: profile.voice_name, voice_rate: profile.voice_rate,
      expression: profile.expression, auto_speak: profile.auto_speak }
    setSaved(current => current && ({ ...current, ...voice }))
    setDraft(current => current && ({ ...current, ...voice }))
  }, [])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  useEffect(() => { onBusyChange?.(blocked) }, [blocked, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    digitalPersonApi.get().then(value => { if (active) { setSaved(value); setDraft(value) } })
      .catch(reason => { if (active) setError(String(reason instanceof Error ? reason.message : reason)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [retry])
  const switchTab = (next: Tab) => {
    if (next === tab || blocked) return
    if (dirty) setPendingTab(next)
    else { setGuide(null); setTab(next) }
  }
  const update = <K extends keyof DigitalPersonProfile>(key: K, value: DigitalPersonProfile[K]) => setDraft(current => current && ({ ...current, [key]: value }))
  const interval = draft?.proactive_interval_minutes ?? 5
  const contactInterval = draft?.proactive_contact_interval_minutes ?? 5
  const memoryBatchSize = draft?.memory_batch_size ?? 100
  const valid = Boolean(Number.isInteger(memoryBatchSize) && memoryBatchSize >= 1 && memoryBatchSize <= 1000 && Number.isInteger(contactInterval) && contactInterval >= 1 && contactInterval <= 1440 && draft?.name.trim() && draft.duties.trim() && Number.isInteger(interval) && interval >= 1 && interval <= 1440 && [draft.quiet_start ?? 22,draft.quiet_end ?? 8].every(v=>Number.isInteger(v)&&v>=0&&v<=23) && (draft.voice_rate ?? 1)>=.5 && (draft.voice_rate ?? 1)<=2)
  const save = async (value = draft) => {
    if (!value || blocked || !Number.isInteger(memoryBatchSize) || memoryBatchSize < 1 || memoryBatchSize > 1000) return false
    setBusy(true); setError('')
    try { const result = await digitalPersonApi.save(value); setSaved(result); setDraft(result); window.dispatchEvent(new Event(DIGITAL_PERSON_CHANGED)); if(!saved?.enabled && result.enabled)enterHome(); return true }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); return false }
    finally { setBusy(false) }
  }
  const toggleEnabled = async (discard = false) => {
    if (!saved || blocked) return
    if (!discard && dirty) { setPendingToggle(true); return }
    if (!saved.enabled && !saved.onboarding_completed) { beginGuide(); return }
    setBusy(true); setError('')
    try {
      const result = await digitalPersonApi.save({ ...saved, enabled: !saved.enabled })
      setSaved(result); setDraft(current => current && ({ ...current, enabled: result.enabled }))
      window.dispatchEvent(new Event(DIGITAL_PERSON_CHANGED))
      if(result.enabled)enterHome()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const checkNow = async () => {
    if (blocked || dirty) return
    setBusy(true); setError(''); setTab('activity')
    try { await digitalRuntimeApi.check() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false); window.dispatchEvent(new Event(DIGITAL_ACTIVITY_CHANGED)) }
  }
  if (loading) return <div className="digital-person-loading"><Spinner />{t('digitalPerson.loading')}</div>
  if (!draft || !saved) return <div role="alert">{error}<Button onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</Button></div>
  return <div className="digital-person-settings">
    <header className="digital-person-header"><h1>{t('digitalPerson.title')}</h1>
      <div className="digital-person-header-actions">
        {busy && <Spinner />}
        <span className="digital-person-status">{t(saved.enabled ? 'digitalPerson.enabled' : 'digitalPerson.disabled')}</span>
        <button type="button" className="settings-switch" role="switch" aria-label={t('digitalPerson.title')}
          aria-checked={saved.enabled} disabled={blocked} onClick={() => void toggleEnabled()}><span className="settings-switch-thumb" /></button>
      </div>
    </header>
    {error && <p role="alert" className="digital-person-error">{error}</p>}
    {guide !== null && <div className="digital-person-guide"><strong>{t('digitalPerson.setupStep',{step:guide+1,total:guideTabs.length})}</strong><span>{t(`digitalPerson.${guideTabs[guide]}`)}</span>
      <Button disabled={blocked} onClick={()=>setGuide(null)}>{t('digitalPerson.setupLater')}</Button>
      <Button disabled={blocked || childDirty || !valid} onClick={async()=>{
        const next=guide+1
        const done=next===guideTabs.length
        if(profileDirty || done){if(!await save({...draft, ...(done?{enabled:true,onboarding_completed:true}:{})}))return}
        if(done){setGuide(null);setTab('card')}else{setGuide(next);setTab(guideTabs[next])}
      }}>{t(guide===guideTabs.length-1?'digitalPerson.finishSetup':'digitalPerson.nextStep')}</Button></div>}
    <div className="digital-person-settings-body">
    <DigitalPersonBodyNavigation name={draft.name} role={draft.role} disabled={blocked}
      selected={tab === 'memory' ? 'brain' : (Object.keys(bodyTabs) as DigitalPersonBodyPart[]).find(part => bodyTabs[part] === tab) ?? null}
      onSelect={part => switchTab(bodyTabs[part])}>
      {!compactLayout && <div className="digital-person-body-relationship"><DigitalPersonRelationship /></div>}
    </DigitalPersonBodyNavigation>
    <section ref={panelRef} id="digital-person-panel" aria-labelledby="digital-person-panel-title">
    <nav className="digital-person-secondary-nav" aria-label={t('digitalPerson.moreSettings')}>
      {auxiliaryTabs.map(value => <button type="button" key={value} data-settings-tab={value} aria-pressed={tab === value} disabled={blocked} onClick={() => switchTab(value)}>{t(value === 'identity' ? 'digitalPerson.identityPersonality' : `digitalPerson.${value}`)}</button>)}
    </nav>
    {tab !== 'channels' && tab !== 'activity' && <h2 id="digital-person-panel-title">{t(tab === 'identity' ? 'digitalPerson.identityPersonality' : tab === 'assistant' || tab === 'memory' ? 'digitalPerson.bodybrain' : tab === 'appearance' ? 'digitalPerson.bodymouth' : tab === 'input' ? 'digitalPerson.bodyears' : tab === 'vision' ? 'digitalPerson.bodyeyes' : tab === 'tools' ? 'digitalPerson.bodyhands' : `digitalPerson.${tab}`)}</h2>}
    {(tab === 'assistant' || tab === 'memory') && <div className="digital-person-brain-tabs" role="tablist" aria-label={t('digitalPerson.bodybrain')}>
      {(['assistant', 'memory'] as const).map(value => <button type="button" key={value} id={`digital-person-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="digital-person-brain-panel" disabled={blocked} onClick={() => switchTab(value)}>{t(value === 'assistant' ? 'digitalPerson.engineTab' : 'digitalPerson.memory')}</button>)}
    </div>}
    {(['identity', 'appearance', 'proactive', 'memory'] as Tab[]).includes(tab) && <div className="digital-person-form-actions"><Button variant="primary" disabled={!valid || !profileDirty || childDirty || childBusy} loading={busy}
      onClick={() => void save()}>{t(tab === 'appearance' ? 'digitalPerson.saveAppearance' : 'common.save')}</Button></div>}
    {tab === 'card' && <article className="digital-person-card">
      {compactLayout && <DigitalPersonRelationship/>}
      <div className="digital-person-card-main"><DigitalPersonAvatar avatar={saved.avatar} /><div><h2>{saved.name}</h2><p className="digital-person-role">{saved.role}</p><p>{[saved.personality,saved.tone].filter(Boolean).join('，')}</p><span className="digital-person-status">{t(saved.enabled ? 'digitalPerson.enabled' : 'digitalPerson.disabled')}</span></div></div>
      <DigitalPersonGrowth /><details className="digital-person-card-details"><summary>{t('digitalPerson.duties')}</summary><p className="digital-person-duties">{saved.duties}</p></details>
      <div className="digital-person-actions"><DigitalPersonChatButton workspace={workspace} onClose={onClose} />
        <Button onClick={() => setTab('identity')}>{t('digitalPerson.edit')}</Button><Button onClick={beginGuide}>{t('digitalPerson.setup')}</Button>
      </div>
    </article>}
    {tab === 'identity' && <div className="digital-person-form">
      <label>{t('digitalPerson.name')}<Input name="name" maxLength={80} value={draft.name} disabled={blocked} onChange={event => update('name', event.target.value)} /></label>
      <DigitalPersonTraitField name="role" label={t('digitalPerson.identityLabel')} value={draft.role} maxLength={200} disabled={blocked}
        presets={['rd','assistant','manager','study','creative','life'].map(key=>t(`digitalPerson.rolePreset${key}` as never))}
        onChange={role=>setDraft(current=>current && ({...current,role,role_binding:null}))}/>
      <Button disabled={blocked} onClick={() => setChooseRole(true)}>{t('digitalPerson.chooseRole')}</Button>
      <DigitalPersonTraitField name="personality" label={t('digitalPerson.personality')} value={draft.personality} maxLength={2000} disabled={blocked} multiline
        presets={['rigorous','curious','patient','proactive','rational','optimistic'].map(key=>t(`digitalPerson.personalityPreset${key}` as never))} onChange={value=>update('personality',value)}/>
      <label>{t('digitalPerson.relationshipStyle')}<Select name="relationship_style" value={draft.relationship_style??'balanced'} disabled={blocked} onChange={event=>update('relationship_style',event.target.value as DigitalPersonProfile['relationship_style'])}>
        {(['balanced','warm','reserved','tsundere'] as const).map(style=><option key={style} value={style}>{t(`digitalPerson.style${style}` as never)}</option>)}
      </Select></label>
      <label>{t('digitalPerson.relationshipPreferences')}<textarea name="relationship_preferences" value={draft.relationship_preferences??''} maxLength={2000} disabled={blocked} placeholder={t('digitalPerson.relationshipPreferencesHint')} onChange={event=>update('relationship_preferences',event.target.value)}/></label>
      <DigitalPersonTraitField name="tone" label={t('digitalPerson.tone')} value={draft.tone ?? ''} maxLength={1000} disabled={blocked}
        presets={['direct','warm','professional','humorous','supportive','detailed'].map(key=>t(`digitalPerson.tonePreset${key}` as never))} onChange={value=>update('tone',value)}/>
      <label>{t('digitalPerson.duties')}<textarea maxLength={8000} value={draft.duties} disabled={blocked} onChange={event => setDraft(current=>current && ({...current,duties:event.target.value,role_binding:null}))} /></label>
      <label>{t('digitalPerson.greeting')}<Input maxLength={500} value={draft.greeting} disabled={blocked} onChange={event => update('greeting', event.target.value)} /></label>
    </div>}
    {tab === 'appearance' && <div className="digital-person-form digital-person-appearance-form">
      <label>{t('digitalPerson.avatar')}<Select value={draft.avatar} disabled={blocked} onChange={event => update('avatar', event.target.value as DigitalPersonProfile['avatar'])}>
        <option value="robot">{t('digitalPerson.robot')}</option><option value="spark">{t('digitalPerson.spark')}</option></Select></label>
      <label className="digital-person-channel-check"><input disabled={blocked} type="checkbox" checked={draft.show_panel ?? true} onChange={e=>update('show_panel',e.target.checked)}/>{t('digitalPerson.showPanel')}</label>
      <label className="digital-person-channel-check"><input disabled={blocked} type="checkbox" checked={draft.floating ?? false} onChange={e=>update('floating',e.target.checked)}/>{t('digitalPerson.showFloating')}</label>
    </div>}
    {tab === 'appearance' && <VoiceOutputSettings parametersOnly initialProfile={saved} onDirtyChange={childChanged} onBusyChange={childBusyChanged} onSaved={voiceSaved} disabled={busy} />}
    {tab === 'activity' && <DigitalPersonActivity titleId="digital-person-panel-title" checking={busy} onNavigate={onClose} />}
    {tab === 'proactive' && <div className="digital-person-form">
      <div className="digital-person-context-setting"><label className="digital-person-channel-check"><input name="reflection_enabled" disabled={blocked} type="checkbox" checked={draft.reflection_enabled ?? true} onChange={e=>update('reflection_enabled',e.target.checked)}/>{t('digitalPerson.enableReflection')}</label>
      <p>{t('digitalPerson.enableReflectionHint')}</p></div>
      <label className="digital-person-channel-check"><input name="proactive_enabled" disabled={blocked} type="checkbox" checked={draft.proactive_enabled ?? false} onChange={e=>update('proactive_enabled',e.target.checked)}/>{t('digitalPerson.enableProactive')}</label>
      <div className="digital-person-context-setting"><label className="digital-person-channel-check"><input name="proactive_shared_context" type="checkbox" checked={draft.proactive_shared_context ?? true} disabled={blocked} onChange={e=>update('proactive_shared_context',e.target.checked)}/>{t('digitalPerson.sharedCheckContext')}</label>
      <p>{t('digitalPerson.sharedCheckContextHint')}</p></div>
      <label>{t('digitalPerson.checkInstruction')}<textarea disabled={blocked} value={draft.proactive_instruction ?? ''} onChange={e=>update('proactive_instruction',e.target.value)} maxLength={4000}/></label>
      <label>{t('digitalPerson.checkInterval')}<Input name="proactive_interval_minutes" type="number" min={1} max={1440} step={1}
        value={Number.isNaN(interval) ? '' : interval} disabled={blocked} onChange={event => update('proactive_interval_minutes', event.target.valueAsNumber)} /></label>
      <label>{t('digitalPerson.contactInterval')}<Input name="proactive_contact_interval_minutes" type="number" min={1} max={1440} step={1}
        value={Number.isNaN(contactInterval) ? '' : contactInterval} disabled={blocked} onChange={event=>update('proactive_contact_interval_minutes',event.target.valueAsNumber)}/></label>
      <div className="digital-person-field-pair"><label>{t('digitalPerson.quietStart')}<Input disabled={blocked} type="number" min={0} max={23} value={Number.isNaN(draft.quiet_start) ? '' : draft.quiet_start ?? 22} onChange={e=>update('quiet_start',e.target.valueAsNumber)}/></label>
      <label>{t('digitalPerson.quietEnd')}<Input disabled={blocked} type="number" min={0} max={23} value={Number.isNaN(draft.quiet_end) ? '' : draft.quiet_end ?? 8} onChange={e=>update('quiet_end',e.target.valueAsNumber)}/></label></div>
      <Button disabled={blocked || dirty} onClick={()=>void checkNow()}>{t('digitalPerson.thinkNow')}</Button>
    </div>}
    {tab === 'channels' && <DigitalPersonChannels workspaceId={workspace?.id} name={saved.name} onDirtyChange={childChanged} onBusyChange={childBusyChanged} />}
    {(tab === 'assistant' || tab === 'memory') && <div id="digital-person-brain-panel" role="tabpanel" aria-labelledby={`digital-person-tab-${tab}`}>
      {tab === 'assistant' ? <AssistantEngineSettings assistantName="digital_person" onDirtyChange={childChanged} onBusyChange={childBusyChanged} /> : <>
        <div className="digital-person-form"><label>{t('digitalPerson.memoryBatchSize')}<Input name="memory_batch_size" type="number" min={1} max={1000} step={1} value={Number.isNaN(memoryBatchSize) ? '' : memoryBatchSize} disabled={blocked} onChange={event=>update('memory_batch_size',event.target.valueAsNumber)}/></label><p>{t('digitalPerson.memoryBatchSizeHint')}</p></div>
        <DigitalPersonMemory name={saved.name} avatar={saved.avatar} /></>}
    </div>}
    {tab === 'input' && <div className="digital-person-input-settings"><VoiceWakeSettings parametersOnly onDirtyChange={childChanged} onBusyChange={childBusyChanged} /></div>}
    {tab === 'vision' && <div className="digital-person-vision"><DigitalPersonCamera autoStart projectId={workspace?.id} /><AssistantEngineSettings assistantName="digital_person" section="vision" onDirtyChange={childChanged} onBusyChange={childBusyChanged} /></div>}
    {tab === 'tools' && <DigitalPersonOperations />}
    </section>
    </div>
    <ConfirmDialog open={pendingTab !== null || pendingToggle} title={t('digitalPerson.discard')} confirmDisabled={blocked} onCancel={() => { setPendingTab(null); setPendingToggle(false) }} onConfirm={() => {
      if (blocked) return
      setDraft(saved); setChildDirty(false); setGuide(null)
      if (pendingToggle) { setPendingToggle(false); void toggleEnabled(true) }
      else { setTab(pendingTab!); setPendingTab(null) }
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
