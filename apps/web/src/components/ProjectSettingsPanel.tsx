import ProjectStorageSettings from './ProjectStorageSettings'
import ResizablePanel from './ResizablePanel'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  chatSessionApi,
  projectApi,
  type Project,
  type ProjectSettingsResult,
} from '../api/client'
import { useI18n } from '../i18n'
import { useChatListStore } from '../stores/chatSessionStore'
import Button from './Button'
import ConcurrencyLimitInput from './ConcurrencyLimitInput'
import Field from './Field'
import Input from './Input'
import MarkdownEditor from './MarkdownEditor'
import QuickButtonEditor, { type QuickButtonDraft, quickButtonToDraft, quickButtonFromDraft } from './QuickButtonEditor'
import SkillCenterSettings from '../pages/SkillCenterSettings'
import ProjectSharingTabs from './ProjectSharingTabs'
import GatewayProjectSettings from './GatewayProjectSettings'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'

interface ProjectSettingsPanelProps {
  project: Project | null
  onClose: () => void
  onProjectRenamed?: (name: string) => void
}

type TabKey = 'general' | 'assistant' | 'quickButtons' | 'skills' | 'concurrency' | 'share'

function randomId(): string {
  return `qb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface ConcurrencyDraft {
  maxTasks: string
  maxChats: string
  scheduleExempt: boolean
}

export default function ProjectSettingsPanel(props: ProjectSettingsPanelProps) {
  const session = useGatewaySessionStore(state => state.session)
  if (props.project && session?.host_project_id === props.project.id) {
    return <GatewayProjectSettings projectId={props.project.id} projectName={props.project.name} onClose={props.onClose} />
  }
  return <LocalProjectSettingsPanel {...props} />
}

function LocalProjectSettingsPanel({
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

  const tabs: { key: TabKey; label: string }[] = useMemo(() => [
    { key: 'general', label: t('projectSettings.tabs.general') },
    { key: 'assistant', label: t('projectSettings.tabs.assistant') },
    { key: 'quickButtons', label: t('projectSettings.tabs.quickButtons') },
    { key: 'skills', label: t('skillCenter.nav') },
    { key: 'concurrency', label: t('projectSettings.tabs.concurrency') },
    ...(project?.type !== 'remote'
      ? [{ key: 'share' as const, label: t('projectSettings.tabs.share') }] : []),
  ], [t, project?.type])

  useEffect(() => {
    if (activeTab === 'share' && project?.type === 'remote') setActiveTab('general')
  }, [activeTab, project?.type])

  const loadSettings = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setLoadError('')
    try {
      const result = await projectApi.settings(projectId, true)
      setSettings(result)
      setNameDraft(result.name)
      setPromptDraft(result.chat_system_prompt || '')
      const quickButtons = (result.quick_buttons || []).map((button: any) => quickButtonToDraft({ ...button, id: button.id || randomId() }))
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

  if (!project) return null

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
      if (button.kind === 'action' && (!button.actionId.trim() || !button.scriptPath.trim())) {
        setSelectedQuickButtonId(button.id)
        setButtonsError('请先设置 Action ID 并选择脚本文件')
        return
      }
    }
    setButtonsSaving(true)
    setButtonsError('')
    setButtonsSaved(false)
    try {
      const savedButtons = await saveQuickButtonsToStore(
        projectId,
        buttonsDraft.map(quickButtonFromDraft),
      )
      setButtonsDraft(savedButtons.map(quickButtonToDraft))
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

  const effective = settings?.concurrency?.effective
  const formatEffective = (value: number) =>
    value === 0 ? t('projectSettings.concurrency.unlimited') : String(value)

  const tabBodyStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <ResizablePanel
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
                {project.type !== 'remote' && <ProjectStorageSettings projectId={project.id} />}
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
              <QuickButtonEditor
                projectId={projectId || ''}
                buttons={buttonsDraft}
                onChange={setButtonsDraft}
                selectedId={selectedQuickButtonId}
                onSelect={setSelectedQuickButtonId}
                onSave={() => void saveQuickButtons()}
                saving={buttonsSaving}
                saved={buttonsSaved}
                error={buttonsError}
                onEdited={() => { setButtonsError(''); setButtonsSaved(false) }}
              />
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
              <ProjectSharingTabs projectId={projectId || ''} />
            )}
          </section>
        </div>
      </ResizablePanel>
    </div>
  )
}
