import Icon from './Icon'
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import CoordinatorConfigBar from './CoordinatorConfigBar'
import FloatingMenu, { useFloatingMenu } from './FloatingMenu'
import ImagePreview from './ImagePreview'
import { engineApi, fsApi, type CoordinatorEngineSummary, type EngineInputItem, type ProviderInfo } from '../api/client'
import { engineLabel } from '../engineMeta'
import { useI18n } from '../i18n'
import {
  removeMarkdownImage,
  resolveMarkdownImageSrc,
  splitMarkdownImages,
  type MarkdownImageSegment,
  type MarkdownTextSegment,
} from '../utils/markdownImages'
import { applySlashInputItem, slashInputQuery } from '../utils/slashSkills'

const inputItemIcon = (item: EngineInputItem) => {
  if (item.kind === 'skill') return 'sparkles' as const
  if (item.action === 'toggle_plan') return 'lightbulb' as const
  if (item.action === 'open_reasoning') return 'sparkles' as const
  if (item.action === 'show_status') return 'bar-chart' as const
  return 'terminal' as const
}

/* ══════════════════════════════════════════
   ChatInput — shared chat composer (Codex style).
   One bordered box containing the textarea, the
   image attach button, the engine/model picker and
   the send/stop button. Used by the task
   conversation and the AI flow-design chat so the
   two never drift.
   ══════════════════════════════════════════ */

export interface ChatInputEngineConfig {
  /** Project scope used for remote engine/provider/model reads. */
  projectId?: string
  engines: CoordinatorEngineSummary[]
  /** Currently selected engine id ('' = follow the default). */
  engine: string
  /** Effective/resolved default engine id for the「默认（…）」label. */
  defaultEngine: string
  model: string
  fastModel: string
  visionModel?: string
  /** '' = follow the engine default. */
  thinkingEffort?: string
  /** Enabled providers for the built-in Pydantic AI engine's dynamic config. */
  providers?: ProviderInfo[]
  /** '' = follow the default provider. */
  providerId?: string
  /** Show the vision-model select (task chat only). */
  showVision?: boolean
  /** Disable the picker (config not loaded / a turn is running). */
  disabled?: boolean
  /** True while a selection is being persisted (task chat only). */
  saving?: boolean
  error?: string
  notice?: string
  hint?: string
  engineTitle?: string
  onEngineChange: (engineId: string) => void
  onProviderChange?: (providerId: string) => void
  onModelChange: (model: string) => void
  onFastModelChange: (model: string) => void
  onVisionModelChange?: (model: string) => void
  onThinkingEffortChange?: (value: string) => void
  /** Reset all selections back to the defaults. */
  onReset?: () => void
}

export interface ChatInputImageAttach {
  projectId: string
  /** Filename prefix for the uploaded image (task/flow scoping). */
  prefix?: string
  /** Called with '' when an upload starts and a message on failure. */
  onError?: (message: string) => void
}

/** Permission-mode selector (Codex-style shield pill, bottom right). */
export interface ChatInputPermission {
  value: string
  onChange: (mode: string) => void
  disabled?: boolean
}

/** Prompt enhancement (aicss AI Agent Input style pill, bottom right). */
export interface ChatInputEnhance {
  enhancing: boolean
  enhanced: boolean
  onEnhance: () => void
  onRevert: () => void
}

/** Context-window usage shown next to the permission pill. */
export interface ChatContextUsage {
  used: number
  total: number
  percent: number
}

/** Codex-style plan mode (lightbulb pill, left side; also reachable from the + menu). */
export interface ChatInputPlan {
  active: boolean
  onChange: (active: boolean) => void
  disabled?: boolean
}

export interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  /** Active project used to discover skills for the selected engine. */
  projectId?: string
  /** Engine that will receive this message; overrides the coordinator picker. */
  skillEngine?: string
  /** Latest command catalog advertised by the active ACP session. */
  availableCommands?: EngineInputItem[]
  placeholder?: string
  /** Disable the textarea (e.g. while an LLM turn is running). */
  disabled?: boolean
  /** True while an LLM turn is running → button shows a spinner. */
  running?: boolean
  /** Provide to turn the button into a red stop control while running. */
  onStop?: () => void
  /** True while a stop request is in flight → stop button disabled (idempotent). */
  stopping?: boolean
  /** Hover title for the red stop control (defaults to 停止生成). */
  stopTitle?: string
  /** Engine/model picker (Codex-style, bottom right). */
  config?: ChatInputEngineConfig
  /** Permission-mode selector (Codex-style shield pill). */
  permission?: ChatInputPermission
  /** Prompt enhancement pill (aicss AI Agent Input style). */
  enhance?: ChatInputEnhance
  /** Context-window usage indicator (Codex-style percent + tooltip). */
  context?: ChatContextUsage | null
  /** Plan-mode toggle (Codex-style lightbulb, left side). */
  plan?: ChatInputPlan
  /** Enable image attach: paste-to-upload + the image button. */
  imageAttach?: ChatInputImageAttach
  /** Optional extra slot rendered at the bottom-left (before the image button). */
  left?: ReactNode
  /** Forwarded to the textarea when imageAttach is not used. */
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  /** Button hover title when in send mode. */
  title?: string
  /** External ref for focusing the composer (e.g. edit-message flows). */
  inputRef?: Ref<HTMLTextAreaElement>
  rows?: number
  minHeight?: number
  maxHeight?: number
}

export default function ChatInput({
  value,
  onChange,
  onSend,
  projectId,
  skillEngine,
  availableCommands,
  placeholder,
  disabled = false,
  running = false,
  onStop,
  stopping = false,
  stopTitle,
  config,
  permission,
  enhance,
  context,
  plan,
  imageAttach,
  left,
  onPaste,
  title,
  inputRef,
  rows = 1,
  minHeight = 40,
  maxHeight = 120,
}: ChatInputProps) {
  const { t, locale } = useI18n()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const segmentRefs = useRef(new Map<number, HTMLTextAreaElement>())
  const inputFocusedRef = useRef(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [configFocus, setConfigFocus] = useState<'model' | 'reasoning' | null>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const permissionMenu = useFloatingMenu()
  const permissionButtonRef = useRef<HTMLButtonElement>(null)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [previewImage, setPreviewImage] = useState<MarkdownImageSegment | null>(null)
  const [focused, setFocused] = useState(false)
  const [slashCursor, setSlashCursor] = useState(value.length)
  const [slashDismissedValue, setSlashDismissedValue] = useState<string | null>(null)
  const [inspectedItems, setInspectedItems] = useState<EngineInputItem[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState(false)
  const [skillIndex, setSkillIndex] = useState(0)
  const attachInputRef = useRef<HTMLInputElement>(null)
  const canSend = !disabled && !running && !stopping && value.trim().length > 0
  const stopped = Boolean(running && onStop)
  const imageAlt = t('md.image')
  const inputSegments = splitMarkdownImages(value)
  const hasImage = inputSegments.some((segment) => segment.type === 'image')
  const textSegmentCount = inputSegments.filter((segment) => segment.type === 'text').length
  const thinkingEffortLabel: Record<string, string> = {
    minimal: t('coord.thinkingLevels.minimal'),
    low: t('coord.thinkingLevels.low'),
    medium: t('coord.thinkingLevels.medium'),
    high: t('coord.thinkingLevels.high'),
  }

  const permissionOptions = [
    { value: '', label: t('chatSession.permissionDefault') },
    { value: 'read-only', label: t('chatSession.permissionReadOnly') },
    { value: 'workspace-write', label: t('chatSession.permissionWorkspaceWrite') },
    { value: 'danger-full-access', label: t('chatSession.permissionFullAccess') },
    { value: 'auto', label: t('chatSession.permissionAuto') },
    { value: 'ask', label: t('chatSession.permissionAsk') },
  ]
  const permissionLabel =
    permissionOptions.find((option) => option.value === permission?.value)?.label
    ?? t('chatSession.permissionDefault')
  const planActive = plan?.active ?? false
  const effectiveEngine = skillEngine || config?.engine || config?.defaultEngine || ''
  const inputItems = availableCommands === undefined
    ? inspectedItems
    : [
        ...availableCommands,
        ...inspectedItems.filter((item) => item.kind === 'skill'),
      ]
  const inputQuery = slashInputQuery(value, slashCursor)
  const slashActive = inputQuery !== null
  const filteredItems = inputItems.filter((item) => {
    const query = (inputQuery ?? '').toLocaleLowerCase()
    return !query
      || item.name.toLocaleLowerCase().includes(query)
      || item.description.toLocaleLowerCase().includes(query)
  })
  const skillMenuVisible = slashActive
    && slashDismissedValue !== value
    && Boolean(projectId && effectiveEngine)

  useEffect(() => {
    if (!inputFocusedRef.current) setSlashCursor(value.length)
  }, [value])

  useEffect(() => {
    if (!slashActive || !projectId || !effectiveEngine) return
    let cancelled = false
    setSkillsLoading(true)
    setSkillsError(false)
    void engineApi.inspect(effectiveEngine, projectId)
      .then((result) => {
        if (!cancelled) {
          setInspectedItems(result.input_items ?? result.skills.map((skill) => ({
            kind: 'skill',
            name: skill.name,
            description: skill.description,
            insert_text: `/${skill.name} `,
            action: 'prompt',
          })))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInspectedItems([])
          setSkillsError(true)
        }
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false)
      })
    return () => { cancelled = true }
  }, [effectiveEngine, projectId, slashActive])

  const formatTokens = (count: number) =>
    new Intl.NumberFormat(locale).format(Math.max(0, Math.round(count)))

  const resizeElement = (element: HTMLTextAreaElement | null) => {
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }

  const focusMarkdownCursor = (markdown: string, cursor: number) => {
    const segments = splitMarkdownImages(markdown)
    let textIndex = -1
    const target = segments.find((segment) => {
      if (segment.type !== 'text') return false
      textIndex += 1
      return cursor >= segment.start && cursor <= segment.end
    }) as MarkdownTextSegment | undefined
    const element = segmentRefs.current.get(Math.max(0, textIndex))
    if (!target || !element) return
    const localCursor = Math.max(0, Math.min(cursor - target.start, target.markdown.length))
    textareaRef.current = element
    element.focus()
    element.setSelectionRange(localCursor, localCursor)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillMenuVisible) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSkillIndex((index) => Math.min(index + 1, Math.max(0, filteredItems.length - 1)))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSkillIndex((index) => Math.max(0, index - 1))
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashDismissedValue(value)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const item = filteredItems[skillIndex] ?? filteredItems[0]
        if (item) selectInputItem(item)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && canSend) {
      event.preventDefault()
      onSend()
    }
  }

  const handleClick = () => {
    if (stopped) onStop?.()
    else if (canSend) onSend()
  }

  const buttonDisabled = stopped ? stopping : !canSend
  const engineId = config?.engine || config?.defaultEngine || 'claude'

  const applySelection = (item: Pick<EngineInputItem, 'insert_text'>) => {
    const selection = applySlashInputItem(value, slashCursor, item)
    onChange(selection.value)
    setSlashCursor(selection.cursor)
    setSlashDismissedValue(selection.value)
    requestAnimationFrame(() => {
      focusMarkdownCursor(selection.value, selection.cursor)
    })
  }

  const selectInputItem = (item: EngineInputItem) => {
    setStatusOpen(false)
    switch (item.action) {
      case 'toggle_plan':
        if (!plan) {
          applySelection(item)
          return
        }
        applySelection({ insert_text: '' })
        plan.onChange(!planActive)
        return
      case 'open_model':
        if (!config) {
          applySelection(item)
          return
        }
        applySelection({ insert_text: '' })
        setConfigFocus('model')
        setConfigOpen(true)
        return
      case 'open_reasoning':
        if (!config) {
          applySelection(item)
          return
        }
        applySelection({ insert_text: '' })
        setConfigFocus('reasoning')
        setConfigOpen(true)
        return
      case 'show_status':
        applySelection({ insert_text: '' })
        setStatusOpen(true)
        return
      case 'prompt':
      default:
        applySelection(item)
    }
  }

  // ── Image attach (single implementation shared by every chat) ──────────
  const handleAttachImage = async (file: File) => {
    if (!imageAttach || !file.type.startsWith('image/')) return
    imageAttach.onError?.('')
    setUploadingImage(true)
    try {
      const uploaded = await fsApi.uploadImage(file, imageAttach.projectId, imageAttach.prefix)
      const markdown = `![${imageAlt}](${uploaded.url})`
      const cursor = Math.max(0, Math.min(slashCursor, value.length))
      const before = value.slice(0, cursor)
      const after = value.slice(cursor)
      const prefix = before && !before.endsWith('\n') ? '\n\n' : ''
      const suffix = after && !after.startsWith('\n') ? '\n\n' : ''
      const nextValue = before + prefix + markdown + suffix + after
      const nextCursor = before.length + prefix.length + markdown.length + suffix.length
      onChange(nextValue)
      setSlashCursor(nextCursor)
      requestAnimationFrame(() => focusMarkdownCursor(nextValue, nextCursor))
    } catch (reason) {
      imageAttach.onError?.(reason instanceof Error ? reason.message : t('chatInput.imageUploadFailed'))
    } finally {
      setUploadingImage(false)
    }
  }

  const handleImagePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items || [])
    const imageItem = items.find((item) => item.type.startsWith('image/'))
    if (!imageItem) return
    const file = imageItem.getAsFile()
    if (!file) return
    event.preventDefault()
    void handleAttachImage(file)
  }

  const updateTextSegment = (
    segment: MarkdownTextSegment,
    nextText: string,
    localCursor: number,
  ) => {
    onChange(value.slice(0, segment.start) + nextText + value.slice(segment.end))
    setSlashCursor(segment.start + localCursor)
    setSlashDismissedValue(null)
    setSkillIndex(0)
    setStatusOpen(false)
  }

  const removeImageSegment = (segment: MarkdownImageSegment) => {
    const nextValue = removeMarkdownImage(value, segment)
    const nextCursor = Math.min(segment.start, nextValue.length)
    onChange(nextValue)
    setSlashCursor(nextCursor)
    requestAnimationFrame(() => focusMarkdownCursor(nextValue, nextCursor))
  }

  return (
    <div className="chat-input-root" style={{ position: 'relative' }}>
      {statusOpen && !skillMenuVisible && (
        <div className="chat-command-status" role="status">
          <div className="chat-command-status-header">
            <strong>{t('chatInput.statusTitle')}</strong>
            <button type="button" onClick={() => setStatusOpen(false)} aria-label={t('common.close')}>×</button>
          </div>
          <div>{t('chatInput.statusEngine')}: {engineLabel(engineId)}</div>
          <div>{t('chatInput.statusModel')}: {config?.model || t('chatInput.defaultModel')}</div>
          <div>{t('chatInput.statusReasoning')}: {config?.thinkingEffort || t('coord.thinkingEffortDefault')}</div>
          <div>{t('chatInput.statusPermission')}: {permissionLabel}</div>
          <div>{t('chatInput.statusPlan')}: {planActive ? t('chatInput.statusEnabled') : t('chatInput.statusDisabled')}</div>
          {context && <div>{t('chatInput.statusContext')}: {Math.round(context.percent)}%</div>}
        </div>
      )}
      {skillMenuVisible && (
        <div
          className="chat-skill-menu"
          role="listbox"
          aria-label={t('chatInput.skillMenu')}
        >
          {skillsLoading ? (
            <div className="chat-skill-menu-status" role="status">
              <span className="task-status-spinner" aria-hidden="true" />
              {t('chatInput.skillsLoading')}
            </div>
          ) : skillsError ? (
            <div className="chat-skill-menu-status" role="status">
              {t('chatInput.skillsLoadFailed')}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="chat-skill-menu-status">{t('chatInput.skillsEmpty')}</div>
          ) : filteredItems.map((item, index) => (
            <button
              key={`${item.kind}:${item.name}`}
              type="button"
              role="option"
              aria-selected={index === skillIndex}
              className="chat-skill-menu-item"
              data-selected={index === skillIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectInputItem(item)}
            >
              <span className="chat-skill-menu-icon" aria-hidden="true">
                <Icon name={inputItemIcon(item)} size={14} strokeWidth={1.7} />
              </span>
              <span className="chat-skill-menu-name">/{item.name}</span>
              <span className="chat-skill-menu-copy">
                {item.description && (
                  <span className="chat-skill-menu-description">{item.description}</span>
                )}
                {item.input_hint && <span className="chat-skill-menu-hint">{item.input_hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <div
        data-focused={focused}
        style={{
          border: '0.5px solid transparent',
          borderRadius: 12,
          background: 'var(--bg)',
          transition: 'box-shadow 0.15s',
          boxShadow: focused
            ? '0 0 0 0.5px var(--accent), 0 1px 2px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.02)'
            : '0 0 0 0.5px var(--border-soft), 0 1px 2px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.02)',
        }}
      >
        <div
          className="chat-input-editor"
          style={{ minHeight, maxHeight }}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return
            const lastInput = segmentRefs.current.get(textSegmentCount - 1)
            lastInput?.focus()
          }}
        >
          {(() => {
            let textIndex = -1
            return inputSegments.map((segment, segmentIndex) => {
              if (segment.type === 'image') {
                return (
                  <div
                    key={`image:${segment.start}:${segment.markdown}`}
                    className="chat-input-image-block"
                    contentEditable={false}
                  >
                    <button
                      type="button"
                      className="chat-input-image"
                      aria-label={`${t('md.preview')}：${segment.alt || imageAlt}`}
                      title={t('md.preview')}
                      onClick={() => setPreviewImage(segment)}
                    >
                      <img
                        src={resolveMarkdownImageSrc(segment.url, imageAttach?.projectId)}
                        alt={segment.alt || imageAlt}
                      />
                    </button>
                    <button
                      type="button"
                      className="chat-input-image-remove"
                      aria-label={`${t('common.delete')}：${segment.alt || imageAlt}`}
                      title={t('common.delete')}
                      disabled={disabled}
                      onClick={() => removeImageSegment(segment)}
                    >
                      <Icon name="x" size={10} strokeWidth={2.4} />
                    </button>
                  </div>
                )
              }

              textIndex += 1
              const currentTextIndex = textIndex
              const isLastText = currentTextIndex === textSegmentCount - 1
              return (
                <textarea
                  key={`text:${segmentIndex}`}
                  ref={(element) => {
                    if (element) {
                      segmentRefs.current.set(currentTextIndex, element)
                      resizeElement(element)
                      if (!textareaRef.current || isLastText) textareaRef.current = element
                    } else {
                      segmentRefs.current.delete(currentTextIndex)
                    }
                    if (isLastText) {
                      if (typeof inputRef === 'function') inputRef(element)
                      else if (inputRef) inputRef.current = element
                    }
                  }}
                  className="chat-input-text-segment"
                  value={segment.markdown}
                  onChange={(event) => {
                    updateTextSegment(segment, event.target.value, event.currentTarget.selectionStart)
                    resizeElement(event.currentTarget)
                  }}
                  onPaste={imageAttach ? handleImagePaste : onPaste}
                  onKeyDown={handleKeyDown}
                  placeholder={inputSegments.length === 1 ? placeholder : undefined}
                  disabled={disabled}
                  rows={rows}
                  onFocus={(event) => {
                    textareaRef.current = event.currentTarget
                    inputFocusedRef.current = true
                    setFocused(true)
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) {
                      inputFocusedRef.current = false
                      setFocused(false)
                    }
                  }}
                  onClick={(event) => setSlashCursor(segment.start + event.currentTarget.selectionStart)}
                  onSelect={(event) => setSlashCursor(segment.start + event.currentTarget.selectionStart)}
                />
              )
            })
          })()}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px 6px' }}>
          {left}
          {imageAttach && (
            <>
              <input
                ref={attachInputRef}
                type="file"
                accept="image/*"
                hidden
                disabled={uploadingImage}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void handleAttachImage(file)
                  e.target.value = ''
                }}
              />
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="chat-input-attach"
                  data-selected={hasImage}
                  data-open={attachMenuOpen}
                  disabled={uploadingImage}
                  title={uploadingImage
                    ? t('chatInput.uploading')
                    : t('chatInput.attachMenuTitle')}
                  aria-label={t('chatInput.attachMenuTitle')}
                  aria-expanded={attachMenuOpen}
                  onClick={() => setAttachMenuOpen((open) => !open)}
                  style={{
                    position: 'relative',
                    cursor: uploadingImage ? 'wait' : 'pointer',
                    opacity: uploadingImage ? 0.7 : 1,
                  }}
                >
                  {uploadingImage
                    ? <span className="task-status-spinner" aria-hidden="true" />
                    : (
                      <Icon
                        name="plus"
                        size={15}
                        strokeWidth={1.8}
                        style={{
                          transform: attachMenuOpen ? 'rotate(45deg)' : undefined,
                          transition: 'transform 200ms cubic-bezier(0.35, 1.55, 0.65, 1)',
                        }}
                      />
                    )}
                  {hasImage && !uploadingImage && (
                    <span
                      aria-hidden="true"
                      style={{
                        position: 'absolute', right: 0, bottom: 0, width: 9, height: 9,
                        borderRadius: '50%', background: 'var(--accent)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <Icon name="check" size={6} strokeWidth={4} color="var(--accent-fg)" />
                    </span>
                  )}
                </button>
                {attachMenuOpen && (
                  <>
                    <div
                      style={{ position: 'fixed', inset: 0, zIndex: 1300 }}
                      onClick={() => setAttachMenuOpen(false)}
                    />
                    <div
                      role="dialog"
                      aria-label={t('chatInput.attachMenuTitle')}
                      className="chat-input-menu"
                      style={{ left: 0, bottom: 'calc(100% + 6px)', zIndex: 1301, width: 190 }}
                    >
                      <button
                        type="button"
                        className="chat-input-menu-item"
                        onClick={() => {
                          setAttachMenuOpen(false)
                          attachInputRef.current?.click()
                        }}
                      >
                        <span className="chat-input-menu-icon">
                          <Icon name="image" size={14} strokeWidth={1.8} />
                        </span>
                        <span className="chat-input-menu-name">{t('chatInput.attachImage')}</span>
                      </button>
                      {plan && (
                        <button
                          type="button"
                          className="chat-input-menu-item"
                          data-selected={planActive}
                          onClick={() => {
                            setAttachMenuOpen(false)
                            plan.onChange(!planActive)
                          }}
                        >
                          <span className="chat-input-menu-icon">
                            <Icon name="lightbulb" size={14} strokeWidth={1.8} />
                          </span>
                          <span className="chat-input-menu-name">{t('chatInput.attachPlanMode')}</span>
                          {planActive && (
                            <Icon name="check" size={13} strokeWidth={2.2} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                          )}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
          {plan && (
            <button
              type="button"
              className="chat-input-pill"
              data-active={planActive}
              disabled={plan.disabled}
              onClick={() => plan.onChange(!planActive)}
              aria-pressed={planActive}
              title={t('chatInput.planModeTitle')}
              style={{ opacity: plan.disabled ? 0.55 : 1, cursor: plan.disabled ? 'not-allowed' : 'pointer' }}
            >
              <Icon name="lightbulb" size={12} strokeWidth={1.8} color={planActive ? '#f5a623' : 'var(--meta)'} />
              <span style={{ color: planActive ? '#f5a623' : 'var(--fg)', fontWeight: planActive ? 600 : 500 }}>
                {t('chatInput.planMode')}
              </span>
            </button>
          )}
          <div style={{ flex: 1 }} />
          {context && (
            <span
              className="chat-input-context"
              role="img"
              aria-label={t('chatInput.contextTokens', { used: formatTokens(context.used), total: formatTokens(context.total) })}
              style={{
                color: context.percent > 90
                  ? 'var(--danger)'
                  : context.percent > 70
                    ? '#d97706'
                    : 'var(--meta)',
              }}
            >
              {Math.round(context.percent)}%
              <span className="chat-input-context-tip">
                {t('chatInput.contextTokens', { used: formatTokens(context.used), total: formatTokens(context.total) })}
              </span>
            </span>
          )}
          {permission && (
            <>
              <button
                ref={permissionButtonRef}
                type="button"
                className="chat-input-pill"
                data-open={permissionMenu.anchor != null}
                disabled={permission.disabled}
                onClick={() => (permissionMenu.anchor ? permissionMenu.close() : permissionMenu.openFrom(permissionButtonRef.current))}
                aria-expanded={permissionMenu.anchor != null}
                title={t('chatSession.permissionLabel')}
                style={{ opacity: permission.disabled ? 0.55 : 1, cursor: permission.disabled ? 'not-allowed' : 'pointer' }}
              >
                <Icon name="shield" size={12} strokeWidth={1.8} color={permission.value ? 'var(--accent)' : 'var(--meta)'} />
                <span style={{ color: permission.value ? 'var(--accent)' : 'var(--fg)', fontWeight: permission.value ? 600 : 500 }}>
                  {permissionLabel}
                </span>
                <Icon name="chevron-down" size={9} strokeWidth={2.5} style={{ transform: permissionMenu.anchor ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s', opacity: 0.6 }} />
              </button>
              {permissionMenu.anchor && (
                <FloatingMenu
                  anchor={permissionMenu.anchor}
                  triggerRef={permissionButtonRef}
                  options={permissionOptions.map((option) => ({ value: option.value, label: option.label }))}
                  value={permission.value}
                  icon="shield"
                  side="top"
                  width={216}
                  title={t('chatSession.permissionTitle')}
                  onSelect={(mode) => { permission.onChange(mode) }}
                  onClose={permissionMenu.close}
                />
              )}
            </>
          )}
          {config && (
            <div style={{ position: 'relative', display: 'flex' }}>
              <button
                type="button"
                className="chat-input-pill"
                data-open={configOpen}
                disabled={config.disabled}
                onClick={() => { setConfigFocus(null); setConfigOpen((open) => !open) }}
                aria-expanded={configOpen}
                title={t('chatInput.engineModelTitle')}
                style={{ opacity: config.disabled ? 0.55 : 1, cursor: config.disabled ? 'not-allowed' : 'pointer' }}
              >
                {config.saving && <span className="task-status-spinner" aria-hidden="true" />}
                <Icon name="sparkles" size={11} strokeWidth={1.8} color="var(--accent)" />
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{engineLabel(engineId)}</span>
                <span style={{ color: 'var(--meta)', opacity: 0.7 }}>·</span>
                <span style={{ color: 'var(--fg)', opacity: 0.9 }}>{config.model || t('chatInput.defaultModel')}</span>
                {config.thinkingEffort && (
                  <>
                    <span style={{ color: 'var(--meta)', opacity: 0.7 }}>·</span>
                    <span style={{ color: 'var(--fg)', opacity: 0.75 }}>
                      {thinkingEffortLabel[config.thinkingEffort] ?? config.thinkingEffort}
                    </span>
                  </>
                )}
                <Icon name="chevron-down" size={9} strokeWidth={2.5} style={{ transform: configOpen ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s', opacity: 0.6 }} />
              </button>
              {configOpen && (
                <>
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 1300 }}
                    onClick={() => setConfigOpen(false)}
                  />
                  <div
                    role="dialog"
                    aria-label={t('chatInput.engineModelDialog')}
                    style={{
                      position: 'absolute', right: 0, bottom: '100%', marginBottom: 8, zIndex: 1301,
                      width: 224, maxHeight: '70vh', overflowY: 'auto',
                      background: 'var(--bg)', border: '1px solid var(--border-soft)', borderRadius: 12,
                      boxShadow: '0 18px 44px rgba(0,0,0,0.20), 0 0 0 1px var(--border-soft)',
                      padding: '6px',
                    }}
                  >
                    {config.onReset && (
                      <button
                        type="button"
                        className="chat-input-menu-reset"
                        style={{ marginBottom: 2 }}
                        onClick={() => { config.onReset?.(); setConfigOpen(false) }}
                      >
                        <Icon name="refresh" size={14} strokeWidth={2} />
                        {t('chatInput.resetDefault')}
                      </button>
                    )}
                    <CoordinatorConfigBar
                      projectId={config.projectId}
                      variant="menu"
                      autoOpenField={configFocus}
                      engines={config.engines}
                      engine={config.engine}
                      defaultEngine={config.defaultEngine}
                      model={config.model}
                      fastModel={config.fastModel}
                      visionModel={config.visionModel}
                      thinkingEffort={config.thinkingEffort}
                      providers={config.providers}
                      providerId={config.providerId}
                      showVision={config.showVision}
                      disabled={config.disabled}
                      error={config.error}
                      notice={config.notice}
                      hint={config.hint}
                      engineTitle={config.engineTitle}
                      onEngineChange={(id) => { config.onEngineChange(id); setConfigOpen(true) }}
                      onProviderChange={config.onProviderChange}
                      onModelChange={config.onModelChange}
                      onFastModelChange={config.onFastModelChange}
                      onVisionModelChange={config.onVisionModelChange}
                      onThinkingEffortChange={config.onThinkingEffortChange}
                    />
                  </div>
                </>
              )}
            </div>
          )}
          {enhance && value.trim() && (
            enhance.enhancing ? (
              <span
                className="task-status-spinner"
                title={t('chatInput.enhancing')}
                aria-label={t('chatInput.enhancing')}
                style={{ color: 'var(--accent)', width: 14, height: 14, flexShrink: 0 }}
              />
            ) : (
              <button
                type="button"
                className="chat-input-pill"
                disabled={running}
                onClick={enhance.enhanced ? enhance.onRevert : enhance.onEnhance}
                title={enhance.enhanced ? t('chatInput.enhanceRevert') : t('chatInput.enhancePrompt')}
                style={{ flexShrink: 0 }}
              >
                <Icon name={enhance.enhanced ? 'rotate-ccw' : 'sparkles'} size={12} strokeWidth={1.8} color={enhance.enhanced ? 'var(--meta)' : 'var(--accent)'} />
                <span style={{ color: enhance.enhanced ? 'var(--fg)' : 'var(--accent)', fontWeight: 600 }}>
                  {enhance.enhanced ? t('chatInput.enhanceRevert') : t('chatInput.enhancePrompt')}
                </span>
              </button>
            )
          )}
          <button
            type="button"
            className="chat-input-send"
            onClick={handleClick}
            disabled={buttonDisabled}
            aria-label={stopped
              ? stopping ? t('chatInput.stopping') : t('common.stop')
              : running
                ? t('chatInput.generating')
                : canSend
                  ? title || t('chatInput.send')
                  : t('chatInput.send')}
            title={stopped
              ? stopping ? t('chatInput.stopping') : (stopTitle ?? t('chatInput.stopGenerating'))
              : running
                ? t('chatInput.generating')
                : title || t('chatInput.send')}
            style={{
              width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
              padding: 0,
              background: stopped ? '#d92d20' : canSend ? 'var(--fg)' : 'transparent',
              color: stopped || canSend ? '#fff' : 'var(--fg-2)',
              border: 'none', cursor: buttonDisabled ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s, color 0.15s, transform 0.15s',
            }}
          >
            {stopped ? (
              <div style={{ width: 12, height: 12, borderRadius: 2, background: 'currentColor' }} />
            ) : running ? (
              <span className="task-status-spinner" aria-hidden="true" />
            ) : (
              <Icon name="send" size={13} strokeWidth={1.6} style={{ padding: 0 }} />
            )}
          </button>
        </div>
      </div>
      {previewImage && (
        <ImagePreview
          src={previewImage.url}
          alt={previewImage.alt}
          projectId={imageAttach?.projectId}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </div>
  )
}
