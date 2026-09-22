import ResponsivePopover from './ResponsivePopover'
import Icon from './Icon'
import { useCompactLayout } from '../hooks/useCompactLayout'
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type Ref,
} from 'react'
import ChatInputTextSegment from './ChatInputTextSegment'
import CoordinatorConfigBar from './CoordinatorConfigBar'
import FloatingMenu, { useFloatingMenu } from './FloatingMenu'
import ImagePreview from './ImagePreview'
import { engineApi, fsApi, type CoordinatorEngineSummary, type EngineConfigField, type EngineInputItem, type EngineQuota, type ProviderInfo } from '../api/client'
import { engineLabel } from '../engineMeta'
import { useI18n } from '../i18n'
import {
  removeMarkdownImage,
  resolveMarkdownImageSrc,
  splitMarkdownImages,
  type MarkdownInputSegment,
  type MarkdownImageSegment,
  type MarkdownTextSegment,
} from '../utils/markdownImages'
import { applySlashInputItem, slashInputQuery } from '../utils/slashSkills'
import { formatMarkdownAttachment } from '../utils/markdownAttachment'
import { loadDraft, loadTaskDraft, saveDraft, saveTaskDraft } from '../utils/chatDraft'
import { useMarkdownUrlResolver } from '../contexts/MarkdownAssetUrlContext'
import {
  applyTaskStepMention,
  taskStepMentionQuery,
} from '../utils/taskStepMention'

const inputItemIcon = (item: EngineInputItem) => {
  if (item.kind === 'skill') return 'sparkles' as const
  if (item.action === 'toggle_plan') return 'lightbulb' as const
  if (item.action === 'open_reasoning') return 'sparkles' as const
  if (item.action === 'show_status') return 'bar-chart' as const
  return 'terminal' as const
}

function readDraft(owner: { type: 'session' | 'task'; id: string }): string {
  return owner.type === 'task' ? loadTaskDraft(owner.id) : loadDraft(owner.id)
}

function writeDraft(owner: { type: 'session' | 'task'; id: string }, value: string): void {
  if (owner.type === 'task') saveTaskDraft(owner.id, value)
  else saveDraft(owner.id, value)
}

function splitComposerSegments(markdown: string): MarkdownInputSegment[] {
  const parsed = splitMarkdownImages(markdown)
  const segments: MarkdownInputSegment[] = []
  for (const segment of parsed) {
    if (segment.type === 'image' && (segments.length === 0 || segments.at(-1)?.type === 'image')) {
      segments.push({
        type: 'text',
        markdown: '',
        start: segment.start,
        end: segment.start,
      })
    }
    segments.push(segment)
  }
  return segments
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
  /** Effective thinking effort shown when thinkingEffort is empty. */
  defaultThinkingEffort?: string
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
  /** Step mode exposes the selected engine's non-sensitive workflow fields. */
  stepFields?: EngineConfigField[]
  stepValues?: Record<string, string>
  onStepFieldChange?: (key: string, value: string) => void
  requireCoordinator?: boolean
  allowDefault?: boolean
  /** Reset all selections back to the defaults. */
  onReset?: () => void
}

export interface ChatInputImageAttach {
  projectId?: string
  /** Public/share composers can inject their session-scoped upload transport. */
  upload?: (file: File, prefix?: string) => Promise<{ url: string; filename: string; size: number }>
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
  estimated?: boolean
  breakdown?: {
    system: number
    toolDefinitions: number
    user: number
    assistant: number
    toolRequests: number
    toolResults: number
    visible: number
    other: number
    estimated: boolean
  }
  tools?: Array<{ name: string; tokens: number }>
}

export type ChatEngineQuota = EngineQuota

/** Codex-style plan mode (lightbulb pill, left side; also reachable from the + menu). */
export interface ChatInputPlan {
  active: boolean
  onChange: (active: boolean) => void
  disabled?: boolean
}

export interface ChatInputMentions {
  options: Array<{ id: string; label: string; color?: string }>
  menuLabel: string
  onSelect: (id: string) => void
}

export interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  /** Session owner for the composer draft. */
  sessionId?: string | null
  /** Task owner for the composer draft. Takes precedence over sessionId. */
  taskId?: string | null
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
  /** Keep sending enabled while running so the message can steer the active turn. */
  allowSendWhileRunning?: boolean
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
  /** Latest account quota reported by the selected engine. */
  quota?: ChatEngineQuota | null
  /** Refresh the selected engine's account quota. */
  onRefreshQuota?: () => void
  /** True while an account quota refresh is in flight. */
  quotaRefreshing?: boolean
  /** Plan-mode toggle (Codex-style lightbulb, left side). */
  plan?: ChatInputPlan
  /** Optional @ completion used by task chat to select a recipient step. */
  mentions?: ChatInputMentions
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
  sessionId,
  taskId,
  projectId,
  skillEngine,
  availableCommands,
  placeholder,
  disabled = false,
  running = false,
  allowSendWhileRunning = false,
  onStop,
  stopping = false,
  stopTitle,
  config,
  permission,
  enhance,
  context,
  quota,
  onRefreshQuota,
  quotaRefreshing = false,
  plan,
  mentions,
  imageAttach,
  left,
  onPaste,
  title,
  inputRef,
  rows = 1,
  minHeight = 110,
  maxHeight = 120,
}: ChatInputProps) {
  const { t, locale } = useI18n()
  const markdownUrlResolver = useMarkdownUrlResolver()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const segmentRefs = useRef(new Map<number, HTMLTextAreaElement>())
  const inputSegmentRefs = useRef(new Map<number, HTMLTextAreaElement>())
  const imageSegmentRefs = useRef(new Map<number, HTMLButtonElement>())
  const inputFocusedRef = useRef(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [configFocus, setConfigFocus] = useState<'model' | 'reasoning' | null>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const isCompact = useCompactLayout()
  const permissionMenu = useFloatingMenu()
  const permissionButtonRef = useRef<HTMLButtonElement>(null)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [previewImage, setPreviewImage] = useState<MarkdownImageSegment | null>(null)
  const [focused, setFocused] = useState(false)
  const [allSelected, setAllSelected] = useState(false)
  const allSelectedRef = useRef(false)
  const undoSnapshotRef = useRef<{ before: string; after: string } | null>(null)
  const [contextTipOpen, setContextTipOpen] = useState(false)
  const contextRef = useRef<HTMLSpanElement>(null)
  const [contextTipStyle, setContextTipStyle] = useState<React.CSSProperties | undefined>(undefined)
  const [quotaTipOpen, setQuotaTipOpen] = useState(false)
  const quotaRef = useRef<HTMLSpanElement>(null)
  const [quotaTipStyle, setQuotaTipStyle] = useState<React.CSSProperties | undefined>(undefined)
  // Close usage detail tips when clicking outside.
  useEffect(() => {
    if (!contextTipOpen && !quotaTipOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setContextTipOpen(false)
      }
      if (quotaRef.current && !quotaRef.current.contains(e.target as Node)) {
        setQuotaTipOpen(false)
      }
    }
    document.addEventListener('click', handleClickOutside, true)
    return () => document.removeEventListener('click', handleClickOutside, true)
  }, [contextTipOpen, quotaTipOpen])
  const [slashCursor, setSlashCursor] = useState(value.length)
  const [slashDismissedValue, setSlashDismissedValue] = useState<string | null>(null)
  const [inspectedItems, setInspectedItems] = useState<EngineInputItem[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState(false)
  const [skillIndex, setSkillIndex] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissedValue, setMentionDismissedValue] = useState<string | null>(null)
  const attachInputRef = useRef<HTMLInputElement>(null)
  const attachFileInputRef = useRef<HTMLInputElement>(null)
  const draftOwnerRef = useRef<{ type: 'session' | 'task'; id: string } | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  // The parent echo caused by restoring a draft must not be treated as user
  // input; a real edit produces a different value and saves normally.
  const restoredValueRef = useRef<string | null>(null)
  const canSend = !disabled
    && (!running || allowSendWhileRunning)
    && !stopping
    && value.trim().length > 0
  const stopped = Boolean(
    running && onStop && !(allowSendWhileRunning && value.trim().length > 0),
  )
  const imageAlt = t('md.image')
  const inputSegments = splitComposerSegments(value)
  const hasImage = inputSegments.some((segment) => segment.type === 'image')
  const isInterImageWhitespace = (segmentIndex: number) => {
    const segment = inputSegments[segmentIndex]
    return segment?.type === 'text'
      && segment.markdown.trim() === ''
      && segment.end > segment.start
      && inputSegments[segmentIndex - 1]?.type === 'image'
      && inputSegments[segmentIndex + 1]?.type === 'image'
  }
  const textSegmentCount = inputSegments.filter((segment, index) => (
    segment.type === 'text' && !isInterImageWhitespace(index)
  )).length
  const thinkingEffortLabel: Record<string, string> = {
    auto: t('coord.thinkingLevels.auto'),
    minimal: t('coord.thinkingLevels.minimal'),
    low: t('coord.thinkingLevels.low'),
    medium: t('coord.thinkingLevels.medium'),
    high: t('coord.thinkingLevels.high'),
    xhigh: t('coord.thinkingLevels.xhigh'),
  }
  const effectiveDefaultThinkingEffort = config?.defaultThinkingEffort === 'auto'
    ? ''
    : config?.defaultThinkingEffort
  const thinkingEffortDisplay = config?.thinkingEffort
    ? thinkingEffortLabel[config.thinkingEffort] ?? config.thinkingEffort
    : effectiveDefaultThinkingEffort
      ? `${t('coord.thinkingEffortDefault')}（${
        thinkingEffortLabel[effectiveDefaultThinkingEffort] ?? effectiveDefaultThinkingEffort
      }）`
      : t('coord.thinkingEffortDefault')

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
  const mentionQuery = mentions ? taskStepMentionQuery(value, slashCursor) : null
  const filteredMentions = (mentions?.options ?? []).filter((option) => {
    const query = (mentionQuery?.query ?? '').toLocaleLowerCase()
    return !query
      || option.label.toLocaleLowerCase().includes(query)
      || option.id.toLocaleLowerCase().includes(query)
  })
  const mentionMenuVisible = mentionQuery !== null
    && mentionDismissedValue !== value
    && filteredMentions.length > 0

  useEffect(() => {
    setMentionIndex(0)
  }, [mentionQuery?.query])

  useEffect(() => {
    const previous = draftOwnerRef.current
    const next = taskId
      ? { type: 'task' as const, id: taskId }
      : sessionId
        ? { type: 'session' as const, id: sessionId }
        : null
    const ownerChanged = previous?.id !== next?.id || previous?.type !== next?.type
    if (ownerChanged) {
      if (previous) writeDraft(previous, valueRef.current)
      draftOwnerRef.current = next
      if (!next) return
      const restored = readDraft(next)
      if (restored !== valueRef.current) {
        restoredValueRef.current = restored
        onChange(restored)
      }
      return
    }
    if (restoredValueRef.current === value) {
      restoredValueRef.current = null
      return
    }
    restoredValueRef.current = null
    if (next) writeDraft(next, value)
  }, [sessionId, taskId, value, onChange])

  useEffect(() => () => {
    const owner = draftOwnerRef.current
    if (owner) writeDraft(owner, valueRef.current)
  }, [])

  useEffect(() => {
    if (!inputFocusedRef.current) setSlashCursor(value.length)
  }, [value])

  useEffect(() => {
    allSelectedRef.current = false
    setAllSelected(false)
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

  const focusMarkdownCursor = (markdown: string, cursor: number) => {
    const segments = splitComposerSegments(markdown)
    let textIndex = -1
    const target = segments.find((segment, segmentIndex) => {
      if (segment.type !== 'text') return false
      const hiddenSeparator = segment.markdown.trim() === ''
        && segment.end > segment.start
        && segments[segmentIndex - 1]?.type === 'image'
        && segments[segmentIndex + 1]?.type === 'image'
      if (hiddenSeparator) return false
      textIndex += 1
      return cursor >= segment.start && cursor <= segment.end
    }) as MarkdownTextSegment | undefined
    const element = segmentRefs.current.get(Math.max(0, textIndex))
    if (!target || !element) return
    const localCursor = Math.max(0, Math.min(cursor - target.start, target.markdown.length))
    textareaRef.current = element
    element.focus({ preventScroll: true })
    element.setSelectionRange(localCursor, localCursor)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const modifier = event.metaKey || event.ctrlKey
    const key = event.key.toLocaleLowerCase()
    if (
      modifier && !event.shiftKey && key === 'z'
      && undoSnapshotRef.current?.after === value
    ) {
      event.preventDefault()
      const restored = undoSnapshotRef.current.before
      undoSnapshotRef.current = null
      onChange(restored)
      setSlashCursor(restored.length)
      requestAnimationFrame(() => focusMarkdownCursor(restored, restored.length))
      return
    }
    if (hasImage && modifier && key === 'a') {
      event.preventDefault()
      allSelectedRef.current = true
      setAllSelected(true)
      for (const element of segmentRefs.current.values()) {
        element.setSelectionRange(0, element.value.length)
      }
      return
    }
    if (allSelectedRef.current && (key === 'backspace' || key === 'delete')) {
      event.preventDefault()
      undoSnapshotRef.current = { before: value, after: '' }
      allSelectedRef.current = false
      setAllSelected(false)
      setSlashCursor(0)
      setSlashDismissedValue(null)
      setStatusOpen(false)
      onChange('')
      requestAnimationFrame(() => focusMarkdownCursor('', 0))
      return
    }
    if (allSelectedRef.current && !(modifier && key === 'c')) {
      allSelectedRef.current = false
      setAllSelected(false)
    }
    if (mentionMenuVisible) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((index) => Math.min(index + 1, filteredMentions.length - 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((index) => Math.max(0, index - 1))
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionDismissedValue(value)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.nativeEvent.isComposing) return
        event.preventDefault()
        const option = filteredMentions[mentionIndex] ?? filteredMentions[0]
        if (option) selectMention(option.id)
        return
      }
    }
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
        if (event.nativeEvent.isComposing) return
        event.preventDefault()
        const item = filteredItems[skillIndex] ?? filteredItems[0]
        if (item) selectInputItem(item)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && canSend && !isCompact) {
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

  const selectMention = (id: string) => {
    if (!mentions) return
    const selection = applyTaskStepMention(value, slashCursor)
    onChange(selection.value)
    mentions.onSelect(id)
    setSlashCursor(selection.cursor)
    setMentionDismissedValue(selection.value)
    requestAnimationFrame(() => {
      focusMarkdownCursor(selection.value, selection.cursor)
    })
  }

  // ── Attachments (single implementation shared by every chat) ───────────
  const handleAttachments = async (files: File[]) => {
    if (!imageAttach || files.length === 0) return
    imageAttach.onError?.('')
    setUploadingImage(true)
    const previousValue = valueRef.current
    let nextValue = previousValue
    let nextCursor = Math.max(0, Math.min(slashCursor, nextValue.length))
    let uploadedAny = false
    try {
      for (const file of files) {
        const isImage = file.type.startsWith('image/')
        try {
          const uploaded = imageAttach.upload
            ? await imageAttach.upload(file, imageAttach.prefix)
            : isImage
              ? await fsApi.uploadImage(file, imageAttach.projectId!, imageAttach.prefix)
              : await fsApi.uploadFile(file, imageAttach.projectId!, imageAttach.prefix)
          const markdown = formatMarkdownAttachment(file, uploaded.url)
          const before = nextValue.slice(0, nextCursor)
          const after = nextValue.slice(nextCursor)
          const beforeEndsWithImage = splitMarkdownImages(before)
            .some((segment) => segment.type === 'image' && segment.end === before.length)
          const afterStartsWithImage = splitMarkdownImages(after)
            .some((segment) => segment.type === 'image' && segment.start === 0)
          const prefix = !isImage && before && !before.endsWith('\n') && !beforeEndsWithImage
            ? '\n\n'
            : ''
          const suffix = !isImage && after && !after.startsWith('\n') && !afterStartsWithImage
            ? '\n\n'
            : ''
          nextValue = before + prefix + markdown + suffix + after
          nextCursor = before.length + prefix.length + markdown.length + suffix.length
          uploadedAny = true
        } catch (reason) {
          imageAttach.onError?.(reason instanceof Error
            ? reason.message
            : isImage ? t('chatInput.imageUploadFailed') : t('chatInput.fileUploadFailed'))
        }
      }
      if (uploadedAny) {
        undoSnapshotRef.current = { before: previousValue, after: nextValue }
        valueRef.current = nextValue
        onChange(nextValue)
        setSlashCursor(nextCursor)
        requestAnimationFrame(() => focusMarkdownCursor(nextValue, nextCursor))
      }
    } finally {
      setUploadingImage(false)
    }
  }

  const handleAttachPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items || [])
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (files.length === 0) return
    event.preventDefault()
    void handleAttachments(files)
  }

  const handleCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!allSelectedRef.current || !event.clipboardData) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', value)
    event.clipboardData.setData('text/markdown', value)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!imageAttach) return
    const files = Array.from(event.dataTransfer?.files || [])
    setDragActive(false)
    if (files.length === 0) return
    event.preventDefault()
    void handleAttachments(files)
  }

  const updateTextSegment = (
    segment: MarkdownTextSegment,
    nextText: string,
    localCursor: number,
  ) => {
    undoSnapshotRef.current = null
    allSelectedRef.current = false
    setAllSelected(false)
    onChange(value.slice(0, segment.start) + nextText + value.slice(segment.end))
    setSlashCursor(segment.start + localCursor)
    setSlashDismissedValue(null)
    setSkillIndex(0)
    setStatusOpen(false)
  }

  const removeImageSegment = (segment: MarkdownImageSegment) => {
    undoSnapshotRef.current = null
    const nextValue = removeMarkdownImage(value, segment)
    const nextCursor = Math.min(segment.start, nextValue.length)
    onChange(nextValue)
    setSlashCursor(nextCursor)
    requestAnimationFrame(() => focusMarkdownCursor(nextValue, nextCursor))
  }

  const handleSegmentKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    segment: MarkdownTextSegment,
    segmentIndex: number,
  ) => {
    const element = event.currentTarget
    if (element.selectionStart === element.selectionEnd) {
      const adjacentImageIndex = event.key === 'ArrowLeft' && element.selectionStart === 0
        ? segmentIndex - 1
        : event.key === 'ArrowRight' && element.selectionStart === segment.markdown.length
          ? segmentIndex + 1
          : -1
      if (inputSegments[adjacentImageIndex]?.type === 'image') {
        event.preventDefault()
        imageSegmentRefs.current.get(adjacentImageIndex)?.focus({ preventScroll: true })
        return
      }
      const adjacent = event.key === 'Backspace' && element.selectionStart === 0
        ? inputSegments[segmentIndex - 1]
        : event.key === 'Delete' && element.selectionStart === segment.markdown.length
          ? inputSegments[segmentIndex + 1]
          : undefined
      if (adjacent?.type === 'image') {
        event.preventDefault()
        removeImageSegment(adjacent)
        return
      }
    }
    handleKeyDown(event)
  }

  return (
    <div className="chat-input-root" style={{ position: 'relative' }}>
      {statusOpen && !skillMenuVisible && !mentionMenuVisible && (
        <div className="chat-command-status" role="status">
          <div className="chat-command-status-header">
            <strong>{t('chatInput.statusTitle')}</strong>
            <button type="button" onClick={() => setStatusOpen(false)} aria-label={t('common.close')}>×</button>
          </div>
          <div>{t('chatInput.statusEngine')}: {engineLabel(engineId)}</div>
          <div>{t('chatInput.statusModel')}: {config?.model || t('chatInput.defaultModel')}</div>
          <div>{t('chatInput.statusReasoning')}: {thinkingEffortDisplay}</div>
          <div>{t('chatInput.statusPermission')}: {permissionLabel}</div>
          <div>{t('chatInput.statusPlan')}: {planActive ? t('chatInput.statusEnabled') : t('chatInput.statusDisabled')}</div>
          {context && <div>{t('chatInput.statusContext')}: {Math.round(context.percent)}%</div>}
        </div>
      )}
      {mentionMenuVisible && mentions && (
        <div
          className="chat-skill-menu"
          role="listbox"
          aria-label={mentions.menuLabel}
        >
          {filteredMentions.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === mentionIndex}
              className="chat-skill-menu-item"
              data-selected={index === mentionIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectMention(option.id)}
            >
              <span
                className="chat-skill-menu-icon"
                aria-hidden="true"
                style={{ color: option.color || 'var(--accent)' }}
              >
                @
              </span>
              <span className="chat-skill-menu-name">{option.label}</span>
            </button>
          ))}
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
        data-dragging={imageAttach ? dragActive : undefined}
        onDragEnter={imageAttach ? (event) => {
          if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return
          event.preventDefault()
          setDragActive(true)
        } : undefined}
        onDragOver={imageAttach ? (event) => {
          if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        } : undefined}
        onDragLeave={imageAttach ? (event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragActive(false)
          }
        } : undefined}
        onDrop={imageAttach ? handleDrop : undefined}
        style={{
          position: 'relative',
          border: '0.5px solid transparent',
          borderRadius: 12,
          background: 'var(--bg)',
          transition: 'box-shadow 0.15s',
          boxShadow: dragActive
            ? '0 0 0 1.5px var(--accent), 0 1px 2px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.02)'
            : focused
              ? '0 0 0 0.5px var(--accent), 0 1px 2px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.02)'
              : '0 0 0 0.5px var(--border-soft), 0 1px 2px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.02)',
        }}
      >
        {imageAttach && dragActive && (
          <div className="chat-input-drop-hint" aria-hidden="true">
            <Icon name="paperclip" size={14} strokeWidth={1.8} />
            <span>{t('chatInput.dropHint')}</span>
          </div>
        )}
        <div
          className="chat-input-editor"
          data-all-selected={allSelected || undefined}
          style={{ minHeight, maxHeight }}
          onCopy={handleCopy}
          onMouseDownCapture={() => {
            if (!allSelectedRef.current) return
            allSelectedRef.current = false
            setAllSelected(false)
          }}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return
            const lastInput = segmentRefs.current.get(textSegmentCount - 1)
            lastInput?.focus({ preventScroll: true })
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
                      ref={(element) => {
                        if (element) imageSegmentRefs.current.set(segmentIndex, element)
                        else imageSegmentRefs.current.delete(segmentIndex)
                      }}
                      type="button"
                      className="chat-input-image"
                      aria-label={`${t('md.preview')}：${segment.alt || imageAlt}`}
                      title={t('md.preview')}
                      onClick={() => setPreviewImage(segment)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                          event.preventDefault()
                          const textSegmentIndex = event.key === 'ArrowLeft'
                            ? segmentIndex - 1
                            : segmentIndex + 1
                          const element = inputSegmentRefs.current.get(textSegmentIndex)
                          if (element) {
                            element.focus({ preventScroll: true })
                            const cursor = event.key === 'ArrowLeft' ? element.value.length : 0
                            element.setSelectionRange(cursor, cursor)
                          }
                          return
                        }
                        if (event.key !== 'Backspace' && event.key !== 'Delete') return
                        event.preventDefault()
                        removeImageSegment(segment)
                      }}
                    >
                      <img
                        src={markdownUrlResolver?.(segment.url)
                          ?? resolveMarkdownImageSrc(segment.url, imageAttach?.projectId)}
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

              if (isInterImageWhitespace(segmentIndex)) return null
              textIndex += 1
              const currentTextIndex = textIndex
              const isLastText = currentTextIndex === textSegmentCount - 1
              const inlineWithImage = !segment.markdown.includes('\n') && (
                inputSegments[segmentIndex - 1]?.type === 'image'
                || inputSegments[segmentIndex + 1]?.type === 'image'
              )
              return (
                <ChatInputTextSegment
                  key={`text:${segmentIndex}`}
                  markdown={segment.markdown}
                  placeholder={inputSegments.length === 1 ? placeholder : undefined}
                  disabled={disabled}
                  rows={rows}
                  inlineWithImage={inlineWithImage}
                  externalRef={isLastText ? inputRef : undefined}
                  onElement={(element) => {
                    if (element) {
                      segmentRefs.current.set(currentTextIndex, element)
                      inputSegmentRefs.current.set(segmentIndex, element)
                      if (!textareaRef.current || isLastText) textareaRef.current = element
                    } else {
                      segmentRefs.current.delete(currentTextIndex)
                      inputSegmentRefs.current.delete(segmentIndex)
                    }
                  }}
                  onCommitText={(text, localCursor) => updateTextSegment(segment, text, localCursor)}
                  onCursorMove={(localCursor) => setSlashCursor(segment.start + localCursor)}
                  onFocusElement={(element) => {
                    textareaRef.current = element
                    inputFocusedRef.current = true
                    setFocused(true)
                  }}
                  onBlurElement={(element, relatedTarget) => {
                    if (!element.parentElement?.contains(relatedTarget as Node | null)) {
                      inputFocusedRef.current = false
                      setFocused(false)
                    }
                  }}
                  onKeyDown={(event) => handleSegmentKeyDown(event, segment, segmentIndex)}
                  onPaste={imageAttach ? handleAttachPaste : onPaste}
                />
              )
            })
          })()}
        </div>
        <div className="chat-input-toolbar">
          <div className="chat-input-toolbar-scroll">
            {left}
            {imageAttach && (
            <>
              <input
                ref={attachInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                disabled={uploadingImage}
                onChange={(e) => {
                  void handleAttachments(Array.from(e.target.files || []))
                  e.target.value = ''
                }}
              />
              <input
                ref={attachFileInputRef}
                type="file"
                multiple
                hidden
                disabled={uploadingImage}
                onChange={(e) => {
                  void handleAttachments(Array.from(e.target.files || []))
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
                  <ResponsivePopover title={t('chatInput.attachMenuTitle')} onClose={() => setAttachMenuOpen(false)} className="chat-input-menu" style={{ left: 0, bottom: 'calc(100% + 6px)', zIndex: 1301, width: 190 }}>
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
                      <button
                        type="button"
                        className="chat-input-menu-item"
                        onClick={() => {
                          setAttachMenuOpen(false)
                          attachFileInputRef.current?.click()
                        }}
                      >
                        <span className="chat-input-menu-icon">
                          <Icon name="paperclip" size={14} strokeWidth={1.8} />
                        </span>
                        <span className="chat-input-menu-name">{t('chatInput.attachFile')}</span>
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
                  </ResponsivePopover>
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
          {quota?.primary && (
            <span
              ref={quotaRef}
              className={`chat-input-context chat-input-quota${quotaTipOpen ? ' is-tip-open' : ''}`}
              tabIndex={0}
              role="button"
              onClick={() => {
                if (isCompact && quotaRef.current) {
                  const rect = quotaRef.current.getBoundingClientRect()
                  setQuotaTipStyle({
                    position: 'fixed',
                    left: '50%',
                    bottom: window.innerHeight - rect.top + 8,
                    transform: 'translateX(-50%)',
                    zIndex: 9999,
                    width: 'max-content',
                    maxWidth: 'calc(100vw - 32px)',
                    whiteSpace: 'normal',
                  })
                } else {
                  setQuotaTipStyle(undefined)
                }
                setQuotaTipOpen((open) => !open)
              }}
            >
              {t('chatInput.quotaCompact', { remaining: quota.primary.remaining_percent })}
              <span className="chat-input-context-tip chat-input-quota-tip" style={quotaTipStyle}>
                <span className="chat-input-quota-heading">
                  <strong>{quota.limit_name || t('chatInput.quotaTitle')}</strong>
                  {onRefreshQuota && (
                    <button
                      type="button"
                      className="chat-input-quota-refresh"
                      data-quota-refresh=""
                      disabled={quotaRefreshing}
                      aria-label={t('common.refresh')}
                      title={t('common.refresh')}
                      onClick={(event) => {
                        event.stopPropagation()
                        onRefreshQuota()
                      }}
                    >
                      {quotaRefreshing
                        ? <span className="task-status-spinner" aria-hidden="true" />
                        : <Icon name="refresh" size={13} strokeWidth={2} />}
                    </button>
                  )}
                </span>
                <span>{t('chatInput.quotaPrimary', {
                  remaining: quota.primary.remaining_percent,
                })}</span>
                <span>{t('chatInput.quotaReset', {
                  reset: quota.primary.resets_at
                    ? new Date(quota.primary.resets_at * 1000).toLocaleString(locale)
                    : t('chatInput.quotaResetUnknown'),
                })}</span>
                {quota.secondary && (
                  <span>{t('chatInput.quotaSecondary', {
                    remaining: quota.secondary.remaining_percent,
                  })}</span>
                )}
                {quota.credits && (
                  <span>{quota.credits.unlimited
                    ? t('chatInput.quotaCreditsUnlimited')
                    : t('chatInput.quotaCredits', { balance: quota.credits.balance ?? '0' })}</span>
                )}
                {quota.individual_limit && (
                  <span>{t('chatInput.quotaIndividual', {
                    used: quota.individual_limit.used,
                    limit: quota.individual_limit.limit,
                    remaining: quota.individual_limit.remaining_percent,
                  })}</span>
                )}
              </span>
            </span>
          )}
          {context && (
            <span
              ref={contextRef}
              className={`chat-input-context chat-input-context-breakdown-wrap${contextTipOpen ? ' is-tip-open' : ''}`}
              tabIndex={0}
              role="button"
              onClick={() => {
                if (isCompact && contextRef.current) {
                  const rect = contextRef.current.getBoundingClientRect()
                  setContextTipStyle({
                    position: 'fixed',
                    left: '50%',
                    bottom: window.innerHeight - rect.top + 8,
                    transform: 'translateX(-50%)',
                    zIndex: 9999,
                    width: 'max-content',
                    maxWidth: 'calc(100vw - 32px)',
                    whiteSpace: 'normal',
                  })
                } else {
                  setContextTipStyle(undefined)
                }
                setContextTipOpen((v) => !v)
              }}
              aria-label={t('chatInput.contextTokens', { used: formatTokens(context.used), total: formatTokens(context.total) })}
              style={{
                color: context.percent > 90
                  ? 'var(--danger)'
                  : context.percent > 70
                    ? '#d97706'
                    : 'var(--meta)',
              }}
            >
              <svg className="chat-input-context-ring" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="chat-input-context-ring-track" cx="12" cy="12" r="9" pathLength="100" />
                <circle
                  className="chat-input-context-ring-value"
                  cx="12"
                  cy="12"
                  r="9"
                  pathLength="100"
                  strokeDasharray={`${Math.min(100, Math.max(0, context.percent))} 100`}
                />
              </svg>
              <span>{Math.round(context.percent)}%</span>
              <span className="chat-input-context-tip chat-input-context-detail" style={contextTipStyle}>
                <span className="chat-input-context-heading">
                  <strong>{t('chatInput.contextCompact', { percent: Math.round(context.percent) })}</strong>
                  <span>{context.estimated ? '~' : ''}{formatTokens(context.used)} / {formatTokens(context.total)}</span>
                </span>
                <span className="chat-input-context-meter"><i style={{ width: `${Math.min(100, context.percent)}%` }} /></span>
                {context.breakdown && (
                  <>
                    <span className="chat-input-context-section-title">
                      {context.breakdown.estimated ? t('chatInput.contextBreakdownEstimated') : t('chatInput.contextBreakdown')}
                    </span>
                    {([
                      ['system', 'contextSystem', '#f59e0b'],
                      ['toolDefinitions', 'contextToolDefinitions', '#0ea5e9'],
                      ['user', 'contextUserMessages', '#d946ef'],
                      ['assistant', 'contextAssistantMessages', '#ec4899'],
                      ['toolRequests', 'contextToolRequests', '#8b5cf6'],
                      ['toolResults', 'contextToolResults', '#10b981'],
                      ['other', 'contextOther', '#94a3b8'],
                    ] as const).filter(([key]) => context.breakdown![key] > 0).map(([key, label, color]) => (
                      <span className="chat-input-context-row" key={key}>
                        <i style={{ background: color }} />
                        <span>{t(`chatInput.${label}`)}</span>
                        <code>~{formatTokens(context.breakdown![key])}</code>
                        <em>{Math.round((context.breakdown![key] / context.used) * 100)}%</em>
                      </span>
                    ))}
                    {context.tools && context.tools.length > 0 && (
                      <>
                        <span className="chat-input-context-section-title">{t('chatInput.contextToolsTop')}</span>
                        {context.tools.map((tool) => (
                          <span className="chat-input-context-tool" key={tool.name}>
                            <code>{tool.name}</code>
                            <span>~{formatTokens(tool.tokens)}</span>
                            <em>{Math.round((tool.tokens / context.used) * 100)}%</em>
                          </span>
                        ))}
                      </>
                    )}
                  </>
                )}
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
                {(config.thinkingEffort || effectiveDefaultThinkingEffort) && (
                  <>
                    <span style={{ color: 'var(--meta)', opacity: 0.7 }}>·</span>
                    <span style={{ color: 'var(--fg)', opacity: 0.75 }}>
                      {thinkingEffortDisplay}
                    </span>
                  </>
                )}
                <Icon name="chevron-down" size={9} strokeWidth={2.5} style={{ transform: configOpen ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s', opacity: 0.6 }} />
              </button>
              {configOpen && (
                <ResponsivePopover title={t('chatInput.engineModelDialog')} onClose={() => setConfigOpen(false)} style={{ position: 'absolute', right: 0, bottom: '100%', marginBottom: 8, zIndex: 1301, width: 224, maxHeight: '70vh', overflowY: 'auto', background: 'var(--bg)', border: '1px solid var(--border-soft)', borderRadius: 12, padding: 6 }}>
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
                      defaultThinkingEffort={config.defaultThinkingEffort}
                      providers={config.providers}
                      providerId={config.providerId}
                      showVision={config.showVision}
                      disabled={config.disabled}
                      error={config.error}
                      notice={config.notice}
                      hint={config.hint}
                      engineTitle={config.engineTitle}
                      stepFields={config.stepFields}
                      stepValues={config.stepValues}
                      onStepFieldChange={config.onStepFieldChange}
                      requireCoordinator={config.requireCoordinator}
                      allowDefault={config.allowDefault}
                      onEngineChange={(id) => { config.onEngineChange(id); setConfigOpen(true) }}
                      onProviderChange={config.onProviderChange}
                      onModelChange={config.onModelChange}
                      onFastModelChange={config.onFastModelChange}
                      onVisionModelChange={config.onVisionModelChange}
                      onThinkingEffortChange={config.onThinkingEffortChange}
                    />
                </ResponsivePopover>
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
          </div>
          <button
            type="button"
            className="chat-input-send"
            onClick={handleClick}
            disabled={buttonDisabled}
            aria-label={stopped
              ? stopping ? t('chatInput.stopping') : t('common.stop')
              : canSend
                ? title || t('chatInput.send')
                : running
                  ? t('chatInput.generating')
                  : t('chatInput.send')}
            title={stopped
              ? stopping ? t('chatInput.stopping') : (stopTitle ?? t('chatInput.stopGenerating'))
              : canSend
                ? title || t('chatInput.send')
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
            ) : running && !canSend ? (
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
