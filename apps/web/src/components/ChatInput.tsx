import Icon from './Icon'
import {
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import CoordinatorConfigBar from './CoordinatorConfigBar'
import FloatingMenu, { useFloatingMenu } from './FloatingMenu'
import { fsApi, type CoordinatorEngineSummary } from '../api/client'
import { engineLabel } from '../engineMeta'
import { useI18n } from '../i18n'

/* ══════════════════════════════════════════
   ChatInput — shared chat composer (Codex style).
   One bordered box containing the textarea, the
   image attach button, the engine/model picker and
   the send/stop button. Used by the task
   conversation and the AI flow-design chat so the
   two never drift.
   ══════════════════════════════════════════ */

export interface ChatInputEngineConfig {
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

export interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
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
  const [configOpen, setConfigOpen] = useState(false)
  const permissionMenu = useFloatingMenu()
  const permissionButtonRef = useRef<HTMLButtonElement>(null)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [focused, setFocused] = useState(false)
  const attachInputRef = useRef<HTMLInputElement>(null)
  const canSend = !disabled && !running && !stopping && value.trim().length > 0
  const stopped = Boolean(running && onStop)
  const imageAlt = t('md.image')
  const hasImage = value.includes(`![${imageAlt}](`)
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

  const formatTokens = (count: number) =>
    new Intl.NumberFormat(locale).format(Math.max(0, Math.round(count)))

  const resize = () => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  // ── Image attach (single implementation shared by every chat) ──────────
  const handleAttachImage = async (file: File) => {
    if (!imageAttach || !file.type.startsWith('image/')) return
    imageAttach.onError?.('')
    setUploadingImage(true)
    try {
      const uploaded = await fsApi.uploadImage(file, imageAttach.projectId, imageAttach.prefix)
      const markdown = `![${imageAlt}](${uploaded.url})`
      onChange(value ? `${value}\n\n${markdown}` : markdown)
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

  return (
    <div style={{ position: 'relative' }}>
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
        <textarea
          ref={(element) => {
            textareaRef.current = element
            if (typeof inputRef === 'function') inputRef(element)
            else if (inputRef) inputRef.current = element
          }}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            resize()
          }}
          onPaste={imageAttach ? handleImagePaste : onPaste}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            width: '100%', border: 'none', outline: 'none', resize: 'none',
            background: 'transparent', color: 'var(--fg)',
            fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: 1.5,
            padding: '8px 10px 2px', minHeight, maxHeight,
          }}
        />
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
                    </div>
                  </>
                )}
              </div>
            </>
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
                onClick={() => setConfigOpen((open) => !open)}
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
                      variant="menu"
                      engines={config.engines}
                      engine={config.engine}
                      defaultEngine={config.defaultEngine}
                      model={config.model}
                      fastModel={config.fastModel}
                      visionModel={config.visionModel}
                      thinkingEffort={config.thinkingEffort}
                      showVision={config.showVision}
                      disabled={config.disabled}
                      error={config.error}
                      notice={config.notice}
                      hint={config.hint}
                      engineTitle={config.engineTitle}
                      onEngineChange={(id) => { config.onEngineChange(id); setConfigOpen(true) }}
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
    </div>
  )
}
