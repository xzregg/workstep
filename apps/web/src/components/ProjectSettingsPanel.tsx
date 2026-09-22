import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  chatSessionApi,
  projectApi,
  remoteProjectApi,
  type Project,
  type ProjectSettingsResult,
  type RemoteDevice,
} from '../api/client'
import { useI18n } from '../i18n'
import { copyText } from '../utils/clipboard'
import { useChatListStore } from '../stores/chatSessionStore'
import { resolveAccessExpiresAt, type AccessDurationPreset } from '../utils/remoteDeviceAccess'
import Button from './Button'
import ConcurrencyLimitInput from './ConcurrencyLimitInput'
import Field from './Field'
import Input from './Input'
import MarkdownEditor from './MarkdownEditor'
import RemoteDeviceAccessList from './RemoteDeviceAccessList'
import Select from './Select'
import SkillCenterSettings from '../pages/SkillCenterSettings'

interface ProjectSettingsPanelProps {
  project: Project | null
  onClose: () => void
  onProjectRenamed?: (name: string) => void
}

type TabKey = 'general' | 'assistant' | 'quickButtons' | 'skills' | 'concurrency' | 'share'

function randomId(): string {
  return `qb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface QuickButtonDraft {
  id: string
  label: string
  prompt: string
}

interface ConcurrencyDraft {
  maxTasks: string
  maxChats: string
  scheduleExempt: boolean
}

export default function ProjectSettingsPanel({
  project,
  onClose,
  onProjectRenamed,
}: ProjectSettingsPanelProps) {
  const { t } = useI18n()
  const projectId = project?.id
  const [activeTab, setActiveTab] = useState<TabKey>('general')

  // ── aggregate data ────────────────────────────────────────────────
  const [settings, setSettings] = useState<ProjectSettingsResult | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)

  // ── general tab ───────────────────────────────────────────────────
  const [nameDraft, setNameDraft] = useState('')
  const [nameSaving, setNameSaving] = useState(false)
  const [nameError, setNameError] = useState('')
  const [nameSaved, setNameSaved] = useState(false)

  // ── assistant tab ─────────────────────────────────────────────────
  const [promptDraft, setPromptDraft] = useState('')
  const [promptSaving, setPromptSaving] = useState(false)
  const [promptError, setPromptError] = useState('')
  const [promptSaved, setPromptSaved] = useState(false)
  const [buttonsDraft, setButtonsDraft] = useState<QuickButtonDraft[]>([])
  const [buttonsSaving, setButtonsSaving] = useState(false)
  const [buttonsError, setButtonsError] = useState('')
  const [buttonsSaved, setButtonsSaved] = useState(false)
  const [selectedQuickButtonId, setSelectedQuickButtonId] = useState('')
  const [draggedQuickButtonId, setDraggedQuickButtonId] = useState('')
  const draggedQuickButtonIdRef = useRef('')
  const saveQuickButtonsToStore = useChatListStore((state) => state.saveQuickButtons)

  // ── concurrency tab ───────────────────────────────────────────────
  const [concurrencyDraft, setConcurrencyDraft] = useState<ConcurrencyDraft>({
    maxTasks: '',
    maxChats: '',
    scheduleExempt: false,
  })
  const [concurrencySaving, setConcurrencySaving] = useState(false)
  const [concurrencyError, setConcurrencyError] = useState('')
  const [concurrencySaved, setConcurrencySaved] = useState(false)

  // ── share tab ─────────────────────────────────────────────────────
  const [access, setAccess] = useState<'internal' | 'external'>('internal')
  const [accessDuration, setAccessDuration] = useState<AccessDurationPreset>('permanent')
  const [customExpiry, setCustomExpiry] = useState('')
  const [shareValue, setShareValue] = useState('')
  const [shareError, setShareError] = useState('')
  const [shareLoading, setShareLoading] = useState(false)
  const [devices, setDevices] = useState<RemoteDevice[]>([])

  const tabs: { key: TabKey; label: string }[] = useMemo(() => [
    { key: 'general', label: t('projectSettings.tabs.general') },
    { key: 'assistant', label: t('projectSettings.tabs.assistant') },
    { key: 'quickButtons', label: t('projectSettings.tabs.quickButtons') },
    { key: 'skills', label: t('skillCenter.nav') },
    { key: 'concurrency', label: t('projectSettings.tabs.concurrency') },
    { key: 'share', label: t('projectSettings.tabs.share') },
  ], [t])

  const loadSettings = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setLoadError('')
    try {
      const result = await projectApi.settings(projectId, true)
      setSettings(result)
      setNameDraft(result.name)
      setPromptDraft(result.chat_system_prompt || '')
      const quickButtons = (result.quick_buttons || []).map((button: any) => ({
        id: button.id || randomId(),
        label: button.label || '',
        prompt: button.prompt || '',
      }))
      setButtonsDraft(quickButtons)
      setSelectedQuickButtonId(quickButtons[0]?.id || '')
      const override = result.concurrency?.project
      const effective = result.concurrency?.effective
      setConcurrencyDraft({
        maxTasks: String(override?.max_tasks ?? effective?.max_tasks ?? 0),
        maxChats: String(override?.max_chats ?? effective?.max_chats ?? 0),
        scheduleExempt: override?.schedule_exempt ?? effective?.schedule_exempt ?? false,
      })
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : t('projectSettings.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  // Share devices polling while the share tab is open.
  useEffect(() => {
    if (!projectId || activeTab !== 'share') return
    let active = true
    const refresh = () => {
      void remoteProjectApi.devices(projectId).then((result) => {
        if (active) setDevices(result.devices)
      }).catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [projectId, activeTab])

  if (!project) return null

  const handleDeviceChange = (device: RemoteDevice) => {
    setDevices((current) => current.map((item) => (
      item.project_id === device.project_id && item.device_id === device.device_id
        ? device
        : item
    )))
  }

  // ── save handlers ─────────────────────────────────────────────────

  const saveName = async () => {
    if (!project || nameSaving) return
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === project.name) {
      setNameError('')
      return
    }
    setNameSaving(true)
    setNameError('')
    setNameSaved(false)
    try {
      await projectApi.rename(project.path, trimmed)
      setNameSaved(true)
      onProjectRenamed?.(trimmed)
    } catch (reason) {
      setNameError(reason instanceof Error ? reason.message : t('projectSettings.saveFailed'))
    } finally {
      setNameSaving(false)
    }
  }

  const saveSystemPrompt = async () => {
    if (!projectId || promptSaving) return
    setPromptSaving(true)
    setPromptError('')
    setPromptSaved(false)
    try {
      await chatSessionApi.saveSystemPrompt(projectId, promptDraft)
      setPromptSaved(true)
    } catch (reason) {
      setPromptError(reason instanceof Error ? reason.message : t('projectSettings.saveFailed'))
    } finally {
      setPromptSaving(false)
    }
  }

  const saveQuickButtons = async () => {
    if (!projectId || buttonsSaving) return
    for (const button of buttonsDraft) {
      if (!button.label.trim()) {
        setSelectedQuickButtonId(button.id)
        setButtonsError(t('chatSession.buttonLabelRequired'))
        return
      }
    }
    setButtonsSaving(true)
    setButtonsError('')
    setButtonsSaved(false)
    try {
      const savedButtons = await saveQuickButtonsToStore(
        projectId,
        buttonsDraft.map((button) => ({ id: button.id, label: button.label.trim(), prompt: button.prompt.trim() })),
      )
      setButtonsDraft(savedButtons)
      setButtonsSaved(true)
    } catch (reason) {
      setButtonsError(reason instanceof Error ? reason.message : t('projectSettings.saveFailed'))
    } finally {
      setButtonsSaving(false)
    }
  }

  const saveConcurrency = async () => {
    if (!projectId || concurrencySaving) return
    const parseLimit = (value: string): number => {
      const trimmed = value.trim()
      if (trimmed === '') return NaN
      return /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
    }
    const maxTasks = parseLimit(concurrencyDraft.maxTasks)
    const maxChats = parseLimit(concurrencyDraft.maxChats)
    if (Number.isNaN(maxTasks) || Number.isNaN(maxChats)) {
      setConcurrencyError(t('projectSettings.concurrency.invalidNumber'))
      return
    }
    setConcurrencySaving(true)
    setConcurrencyError('')
    setConcurrencySaved(false)
    try {
      const result = await projectApi.setConcurrency(projectId, {
        maxTasks,
        maxChats,
        scheduleExempt: concurrencyDraft.scheduleExempt,
      })
      const override = result.project
      setConcurrencyDraft({
        maxTasks: String(override.max_tasks ?? 0),
        maxChats: String(override.max_chats ?? 0),
        scheduleExempt: override.schedule_exempt === true,
      })
      setConcurrencySaved(true)
    } catch (reason) {
      setConcurrencyError(reason instanceof Error ? reason.message : t('projectSettings.saveFailed'))
    } finally {
      setConcurrencySaving(false)
    }
  }

  const createShare = async () => {
    if (shareLoading) return
    setShareLoading(true)
    setShareError('')
    try {
      const accessExpiresAt = resolveAccessExpiresAt(accessDuration, customExpiry)
      const result = await remoteProjectApi.createShare(project.id, access, accessExpiresAt)
      setShareValue(result.share_string)
    } catch (reason) {
      setShareError(
        accessDuration === 'custom' && (!customExpiry || new Date(customExpiry).getTime() <= Date.now())
          ? t('layout.expiryFutureRequired')
          : reason instanceof Error
            ? reason.message
            : t('layout.remoteShareFailed'),
      )
    } finally {
      setShareLoading(false)
    }
  }

  const effective = settings?.concurrency?.effective
  const activeQuickButtonIndex = buttonsDraft.findIndex((button) => button.id === selectedQuickButtonId)
  const activeQuickButton = activeQuickButtonIndex >= 0 ? buttonsDraft[activeQuickButtonIndex] : null
  const reorderQuickButton = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return
    setButtonsDraft((current) => {
      const sourceIndex = current.findIndex((button) => button.id === sourceId)
      const targetIndex = current.findIndex((button) => button.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return current
      const next = [...current]
      const [moved] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, moved)
      return next
    })
    setButtonsSaved(false)
  }
  const formatEffective = (value: number) =>
    value === 0 ? t('projectSettings.concurrency.unlimited') : String(value)

  const tabBodyStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${t('projectSettings.title')} · ${project.name}`}
        style={{ width: 860, height: '78vh', padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header" style={{ flexShrink: 0, paddingLeft: 20 }}>
          <span className="modal-title">{t('projectSettings.title')} · {project.name}</span>
          <Button variant="icon" aria-label={t('common.close')} onClick={onClose}>✕</Button>
        </div>
        <div className="project-settings-layout" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* ── left index ── */}
          <nav
            aria-label={t('projectSettings.title')}
            style={{
              width: 190, flexShrink: 0, borderRight: '1px solid var(--border-soft)',
              padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 2,
              overflowY: 'auto',
            }}
          >
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                aria-current={activeTab === tab.key ? 'page' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%', border: 'none',
                  borderRadius: 8, padding: '8px 10px', cursor: 'pointer', textAlign: 'left',
                  background: activeTab === tab.key ? 'var(--bg)' : 'transparent',
                  color: activeTab === tab.key ? 'var(--fg)' : 'var(--muted)',
                  fontSize: 'calc(13px * var(--font-scale))', fontWeight: activeTab === tab.key ? 650 : 500,
                }}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          {/* ── right scrollable content ── */}
          <section
            aria-label={tabs.find((tab) => tab.key === activeTab)?.label}
            style={{ flex: 1, minWidth: 0, padding: '16px 22px 22px', overflowY: 'auto' }}
          >
            <div style={{
              fontSize: 'calc(15px * var(--font-scale))', fontWeight: 700, fontFamily: 'var(--font-display)',
              color: 'var(--fg)', marginBottom: 14, flexShrink: 0,
            }}>
              {tabs.find((tab) => tab.key === activeTab)?.label}
            </div>
            {loadError && (
              <div role="status" style={{ color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))', marginBottom: 12 }}>
                {loadError}
              </div>
            )}
            {loading && !settings ? (
              <div style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))' }}>
                {t('common.loading')}
              </div>
            ) : activeTab === 'general' ? (
              <div style={tabBodyStyle}>
                <Field label={t('projectSettings.general.name')} error={nameError || undefined}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Input
                      value={nameDraft}
                      onChange={(event) => { setNameDraft(event.target.value); setNameError(''); setNameSaved(false) }}
                      placeholder={t('projectSettings.general.namePlaceholder')}
                      style={{ flex: 1 }}
                    />
                    <Button
                      variant="primary"
                      loading={nameSaving}
                      disabled={!nameDraft.trim() || nameDraft.trim() === project.name}
                      onClick={() => void saveName()}
                    >
                      {t('common.save')}
                    </Button>
                  </div>
                  {nameSaved && (
                    <div role="status" style={{ color: 'var(--success)', fontSize: 'calc(12px * var(--font-scale))' }}>
                      {t('projectSettings.general.nameSaved')}
                    </div>
                  )}
                </Field>
                <Field label={t('projectSettings.general.path')}>
                  <div style={{
                    padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)',
                    background: 'var(--surface)', color: 'var(--muted)',
                    fontSize: 'calc(12px * var(--font-scale))', fontFamily: 'var(--font-mono)',
                    wordBreak: 'break-all',
                  }}>
                    {project.path}
                  </div>
                </Field>
              </div>
            ) : activeTab === 'assistant' ? (
              <div style={tabBodyStyle}>
                <Field
                  label={t('projectSettings.assistant.systemPrompt')}
                  help={t('projectSettings.assistant.systemPromptHint')}
                  error={promptError || undefined}
                >
                  <MarkdownEditor
                    value={promptDraft}
                    onChange={(value) => { setPromptDraft(value); setPromptError(''); setPromptSaved(false) }}
                    projectId={projectId}
                    imagePrefix="system-prompt"
                    placeholder={t('chatSession.systemPromptPlaceholder')}
                    minHeight={180}
                    maxHeight={300}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                    <Button variant="primary" loading={promptSaving} onClick={() => void saveSystemPrompt()}>
                      {t('common.save')}
                    </Button>
                    {promptSaved && (
                      <span role="status" style={{ color: 'var(--success)', fontSize: 'calc(12px * var(--font-scale))' }}>
                        {t('projectSettings.assistant.promptSaved')}
                      </span>
                    )}
                  </div>
                </Field>
              </div>
            ) : activeTab === 'quickButtons' ? (
              <div style={tabBodyStyle}>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
                  {t('projectSettings.assistant.quickButtonsHint')} {t('projectSettings.assistant.quickButtonsDragHint')}
                </p>
                {buttonsError && (
                  <div role="status" style={{ color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>
                    {buttonsError}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 18, alignItems: 'stretch', minHeight: 300 }}>
                  <div
                    data-testid="quick-button-list"
                    style={{
                      width: 180, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
                      paddingRight: 14, borderRight: '1px solid var(--border-soft)',
                    }}
                  >
                    {buttonsDraft.map((button) => {
                      const selected = button.id === selectedQuickButtonId
                      return (
                        <button
                          key={button.id}
                          type="button"
                          draggable
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => setSelectedQuickButtonId(button.id)}
                          onDragStart={(event) => {
                            draggedQuickButtonIdRef.current = button.id
                            setDraggedQuickButtonId(button.id)
                            if (event.dataTransfer) {
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', button.id)
                            }
                          }}
                          onDragOver={(event) => {
                            event.preventDefault()
                            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
                          }}
                          onDrop={(event) => {
                            event.preventDefault()
                            reorderQuickButton(
                              event.dataTransfer?.getData('text/plain') || draggedQuickButtonIdRef.current,
                              button.id,
                            )
                            draggedQuickButtonIdRef.current = ''
                            setDraggedQuickButtonId('')
                          }}
                          onDragEnd={() => {
                            draggedQuickButtonIdRef.current = ''
                            setDraggedQuickButtonId('')
                          }}
                          style={{
                            width: '100%', minHeight: 38, padding: '7px 10px', borderRadius: 8,
                            border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                            background: selected ? 'color-mix(in oklab, var(--accent), transparent 92%)' : 'var(--surface)',
                            color: selected ? 'var(--accent)' : 'var(--fg-2)', textAlign: 'left',
                            font: 'inherit', fontSize: 'calc(12px * var(--font-scale))',
                            fontWeight: selected ? 650 : 500, cursor: 'grab',
                            opacity: draggedQuickButtonId === button.id ? 0.55 : 1,
                          }}
                        >
                          {button.label.trim() || t('projectSettings.assistant.newButton')}
                        </button>
                      )
                    })}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const id = randomId()
                        setButtonsDraft((current) => [...current, { id, label: '', prompt: '' }])
                        setSelectedQuickButtonId(id)
                        setButtonsError('')
                        setButtonsSaved(false)
                      }}
                      style={{ width: '100%', justifyContent: 'flex-start' }}
                    >
                      {t('projectSettings.assistant.addButton')}
                    </Button>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {activeQuickButton ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <Field label={t('projectSettings.assistant.buttonLabel')}>
                          <Input
                            value={activeQuickButton.label}
                            onChange={(event) => {
                              setButtonsDraft((current) => current.map((item, itemIndex) =>
                                itemIndex === activeQuickButtonIndex ? { ...item, label: event.target.value } : item,
                              ))
                              setButtonsError('')
                              setButtonsSaved(false)
                            }}
                            placeholder={t('projectSettings.assistant.buttonLabel')}
                          />
                        </Field>
                        <Field label={t('projectSettings.assistant.buttonPrompt')}>
                          <MarkdownEditor
                            value={activeQuickButton.prompt}
                            onChange={(value) => {
                              setButtonsDraft((current) => current.map((item, itemIndex) =>
                                itemIndex === activeQuickButtonIndex ? { ...item, prompt: value } : item,
                              ))
                              setButtonsError('')
                              setButtonsSaved(false)
                            }}
                            projectId={projectId}
                            imagePrefix="quick-button"
                            placeholder={t('projectSettings.assistant.buttonPrompt')}
                            minHeight={140}
                            maxHeight={280}
                          />
                        </Field>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <Button variant="primary" loading={buttonsSaving} onClick={() => void saveQuickButtons()}>
                            {t('common.save')}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              const remaining = buttonsDraft.filter((_, index) => index !== activeQuickButtonIndex)
                              const nextButton = remaining[activeQuickButtonIndex] || remaining[activeQuickButtonIndex - 1]
                              setButtonsDraft(remaining)
                              setSelectedQuickButtonId(nextButton?.id || '')
                              setButtonsError('')
                              setButtonsSaved(false)
                            }}
                            style={{ color: 'var(--danger)' }}
                          >
                            {t('common.delete')}
                          </Button>
                          {buttonsSaved && (
                            <span role="status" style={{ color: 'var(--success)', fontSize: 'calc(12px * var(--font-scale))' }}>
                              {t('projectSettings.assistant.buttonsSaved')}
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
                        {t('projectSettings.assistant.noQuickButtons')}
                      </div>
                    )}
                  </div>
                </div>
                {!activeQuickButton && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Button variant="primary" loading={buttonsSaving} onClick={() => void saveQuickButtons()}>
                      {t('common.save')}
                    </Button>
                    {buttonsSaved && (
                      <span role="status" style={{ color: 'var(--success)', fontSize: 'calc(12px * var(--font-scale))' }}>
                        {t('projectSettings.assistant.buttonsSaved')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : activeTab === 'skills' ? (
              <SkillCenterSettings project={project} embedded />
            ) : activeTab === 'concurrency' ? (
              <div style={tabBodyStyle}>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
                  {t('projectSettings.concurrency.hint')}
                </p>
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12,
                }}>
                  <Field
                    label={t('projectSettings.concurrency.maxTasks')}
                    help={t('projectSettings.concurrency.projectLevelHint')}
                    error={concurrencyError || undefined}
                  >
                    <ConcurrencyLimitInput
                      id="project-max-tasks"
                      value={concurrencyDraft.maxTasks}
                      unlimitedLabel={t('projectSettings.concurrency.unlimited')}
                      onValueChange={(value) => { setConcurrencyDraft((current) => ({ ...current, maxTasks: value })); setConcurrencySaved(false) }}
                    />
                  </Field>
                  <Field
                    label={t('projectSettings.concurrency.maxChats')}
                    help={t('projectSettings.concurrency.projectLevelHint')}
                  >
                    <ConcurrencyLimitInput
                      id="project-max-chats"
                      value={concurrencyDraft.maxChats}
                      unlimitedLabel={t('projectSettings.concurrency.unlimited')}
                      onValueChange={(value) => { setConcurrencyDraft((current) => ({ ...current, maxChats: value })); setConcurrencySaved(false) }}
                    />
                  </Field>
                </div>
                <Field label={t('projectSettings.concurrency.scheduleExempt')} help={t('projectSettings.concurrency.scheduleExemptHint')}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={concurrencyDraft.scheduleExempt}
                      onChange={(event) => setConcurrencyDraft((current) => ({ ...current, scheduleExempt: event.target.checked }))}
                      style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
                    />
                    <span style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--fg)' }}>
                      {t('projectSettings.concurrency.scheduleExempt')}
                    </span>
                  </label>
                </Field>
                {effective && (
                  <div style={{
                    borderRadius: 10, padding: '10px 14px',
                    background: 'color-mix(in oklab, var(--accent), transparent 93%)',
                    border: '1px solid color-mix(in oklab, var(--accent), transparent 78%)',
                  }}>
                    <div style={{ fontSize: 'calc(12px * var(--font-scale))', fontWeight: 650, color: 'var(--fg)', marginBottom: 6 }}>
                      {t('projectSettings.concurrency.effective')}
                    </div>
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--fg-2)' }}>
                      <span>
                        {t('projectSettings.concurrency.maxTasks')}：
                        <strong>{formatEffective(effective.max_tasks)}</strong>
                      </span>
                      <span>
                        {t('projectSettings.concurrency.maxChats')}：
                        <strong>{formatEffective(effective.max_chats)}</strong>
                      </span>
                      <span>
                        {t('projectSettings.concurrency.scheduleExempt')}：
                        <strong>{effective.schedule_exempt ? t('common.yes') : t('common.no')}</strong>
                      </span>
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Button variant="primary" loading={concurrencySaving} onClick={() => void saveConcurrency()}>
                    {t('projectSettings.concurrency.save')}
                  </Button>
                  {concurrencySaved && (
                    <span role="status" style={{ color: 'var(--success)', fontSize: 'calc(12px * var(--font-scale))' }}>
                      {t('projectSettings.concurrency.saved')}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div style={tabBodyStyle}>
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
                  {t('projectSettings.share.generateHint')}
                </p>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Button
                    variant={access === 'internal' ? 'primary' : 'ghost'}
                    onClick={() => { setAccess('internal'); setShareValue(''); setShareError('') }}
                  >
                    {t('layout.internalAccess')}
                  </Button>
                  <Button
                    variant={access === 'external' ? 'primary' : 'ghost'}
                    onClick={() => { setAccess('external'); setShareValue(''); setShareError('') }}
                  >
                    {t('layout.externalAccess')}
                  </Button>
                </div>
                <Field label={t('layout.deviceAccessDuration')} error={shareError || undefined}>
                  <Select
                    value={accessDuration}
                    onChange={(event) => {
                      setAccessDuration(event.target.value as AccessDurationPreset)
                      setShareValue('')
                      setShareError('')
                    }}
                    style={{ width: '100%' }}
                  >
                    <option value="permanent">{t('layout.accessPermanent')}</option>
                    <option value="day">{t('layout.accessOneDay')}</option>
                    <option value="week">{t('layout.accessSevenDays')}</option>
                    <option value="month">{t('layout.accessThirtyDays')}</option>
                    <option value="custom">{t('layout.accessCustom')}</option>
                  </Select>
                </Field>
                {accessDuration === 'custom' && (
                  <Field label={t('layout.customExpiry')}>
                    <Input
                      type="datetime-local"
                      value={customExpiry}
                      onChange={(event) => { setCustomExpiry(event.target.value); setShareValue(''); setShareError('') }}
                    />
                  </Field>
                )}
                {shareValue && (
                  <Field label={t('layout.remoteShareString')}>
                    <textarea
                      readOnly
                      value={shareValue}
                      rows={5}
                      style={{ width: '100%', resize: 'vertical', border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--surface)', color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 'calc(11px * var(--font-scale))' }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <Button variant="ghost" size="sm" onClick={() => void copyText(shareValue)}>
                        {t('common.copy')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setShareValue('')}>
                        {t('common.close')}
                      </Button>
                    </div>
                  </Field>
                )}
                <Button
                  variant="primary"
                  loading={shareLoading}
                  disabled={accessDuration === 'custom' && !customExpiry}
                  onClick={() => void createShare()}
                >
                  {t('layout.generateShare')}
                </Button>
                <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 14 }}>
                  <div style={{ fontSize: 'calc(12px * var(--font-scale))', fontWeight: 650, marginBottom: 7 }}>
                    {t('projectSettings.share.devices')}（{t('projectSettings.share.invites')}：
                    {settings?.share?.active_invites ?? 0}）
                  </div>
                  <RemoteDeviceAccessList
                    devices={devices}
                    onDeviceChange={handleDeviceChange}
                    onError={setShareError}
                  />
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
