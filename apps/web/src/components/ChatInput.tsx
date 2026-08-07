import Icon from './Icon'
import { useRef, useState, type ClipboardEvent, type ReactNode } from 'react'
import CoordinatorConfigBar from './CoordinatorConfigBar'
import { fsApi, type CoordinatorEngineSummary } from '../api/client'
import { engineLabel } from '../engineMeta'

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
  /** Show the vision-model select (task chat only). */
  showVision?: boolean
  /** Disable the picker (config not loaded / a turn is running). */
  disabled?: boolean
  /** True while a selection is being persisted (task chat only). */
  saving?: boolean
  error?: string
  notice?: string
  /** Static right-side hint (e.g. 仅本次生成会话生效). */
  hint?: string
  engineTitle?: string
  onEngineChange: (engineId: string) => void
  onModelChange: (model: string) => void
  onFastModelChange: (model: string) => void
  onVisionModelChange?: (model: string) => void
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
  /** Engine/model picker (Codex-style, bottom right). */
  config?: ChatInputEngineConfig
  /** Enable image attach: paste-to-upload + the image button. */
  imageAttach?: ChatInputImageAttach
  /** Optional extra slot rendered at the bottom-left (before the image button). */
  left?: ReactNode
  /** Forwarded to the textarea when imageAttach is not used. */
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  /** Button hover title when in send mode. */
  title?: string
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
  config,
  imageAttach,
  left,
  onPaste,
  title,
  rows = 1,
  minHeight = 40,
  maxHeight = 120,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [focused, setFocused] = useState(false)
  const canSend = !disabled && !running && value.trim().length > 0
  const stopped = Boolean(running && onStop)
  const hasImage = value.includes('![图片](')

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

  const buttonDisabled = stopped ? false : !canSend
  const engineId = config?.engine || config?.defaultEngine || 'claude'

  // ── Image attach (single implementation shared by every chat) ──────────
  const handleAttachImage = async (file: File) => {
    if (!imageAttach || !file.type.startsWith('image/')) return
    imageAttach.onError?.('')
    setUploadingImage(true)
    try {
      const uploaded = await fsApi.uploadImage(file, imageAttach.projectId, imageAttach.prefix)
      const markdown = `![图片](${uploaded.url})`
      onChange(value ? `${value}\n\n${markdown}` : markdown)
    } catch (reason) {
      imageAttach.onError?.(reason instanceof Error ? reason.message : '图片上传失败')
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
          border: `1px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 14,
          background: 'var(--bg)',
          transition: 'border-color 0.15s, box-shadow 0.15s',
          boxShadow: focused
            ? '0 0 0 3px color-mix(in oklab, var(--accent), transparent 90%)'
            : undefined,
        }}
      >
        <textarea
          ref={textareaRef}
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
            fontFamily: 'var(--font-body)', fontSize: 13, lineHeight: 1.5,
            padding: '10px 14px 2px', minHeight, maxHeight,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 8px' }}>
          {left}
          {imageAttach && (
            <label
              className="chat-input-attach"
              data-selected={hasImage}
              title={uploadingImage
                ? '上传中…'
                : hasImage
                  ? '已附带图片，可继续添加或粘贴'
                  : '上传图片，发送给协调 Agent 分析'}
              style={{
                position: 'relative',
                cursor: uploadingImage ? 'wait' : 'pointer',
                opacity: uploadingImage ? 0.7 : 1,
              }}
            >
              <input
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
              {uploadingImage
                ? <span className="task-status-spinner" aria-hidden="true" />
                : <Icon name="image" size={18} strokeWidth={1.8} />}
              {hasImage && !uploadingImage && (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute', right: 1, bottom: 1, width: 10, height: 10,
                    borderRadius: '50%', background: 'var(--accent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Icon name="check" size={7} strokeWidth={4} color="var(--accent-fg)" />
                </span>
              )}
            </label>
          )}
          <div style={{ flex: 1 }} />
          {config && (
            <button
              type="button"
              className="chat-input-pill"
              data-open={configOpen}
              disabled={config.disabled}
              onClick={() => setConfigOpen((open) => !open)}
              aria-expanded={configOpen}
              title="选择本次对话的协调引擎与模型"
              style={{ opacity: config.disabled ? 0.55 : 1, cursor: config.disabled ? 'not-allowed' : 'pointer' }}
            >
              {config.saving && <span className="task-status-spinner" aria-hidden="true" />}
              <Icon name="sparkles" size={11} strokeWidth={1.8} color="var(--accent)" />
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{engineLabel(engineId)}</span>
              <span style={{ color: 'var(--meta)', opacity: 0.7 }}>·</span>
              <span style={{ color: 'var(--fg)', opacity: 0.9 }}>{config.model || '默认'}</span>
              <Icon name="chevron-down" size={9} strokeWidth={2.5} style={{ transform: configOpen ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s', opacity: 0.6 }} />
            </button>
          )}
          <button
            type="button"
            className="chat-input-send"
            onClick={handleClick}
            disabled={buttonDisabled}
            aria-label={stopped
              ? '停止'
              : running
                ? '生成中…'
                : canSend
                  ? title || '发送'
                  : '发送'}
            title={stopped
              ? '停止生成'
              : running
                ? '生成中…'
                : title || '发送'}
            style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: stopped ? '#d92d20' : canSend ? 'var(--accent)' : 'var(--border)',
              color: stopped || canSend ? '#fff' : 'var(--fg-2)',
              border: 'none', cursor: buttonDisabled ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
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

      {config && configOpen && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 1300 }}
            onClick={() => setConfigOpen(false)}
          />
          <div
            role="dialog"
            aria-label="引擎与模型设置"
            style={{
              position: 'absolute', right: 0, bottom: '100%', marginBottom: 8, zIndex: 1301,
              width: 300, maxHeight: '70vh', overflowY: 'auto',
              background: 'var(--bg)', border: '1px solid var(--border-soft)', borderRadius: 14,
              boxShadow: '0 18px 44px rgba(0,0,0,0.20), 0 0 0 1px var(--border-soft)',
              padding: '8px',
            }}
          >
            {config.onReset && (
              <button
                type="button"
                className="chat-input-menu-reset"
                onClick={() => { config.onReset?.(); setConfigOpen(false) }}
              >
                <Icon name="refresh" size={14} strokeWidth={2} />
                重置为默认设置
              </button>
            )}
            <div style={{
              fontSize: 11, fontWeight: 600, color: 'var(--meta)',
              margin: '8px 6px 8px', paddingTop: 8,
              borderTop: '1px solid var(--border-soft)',
            }}>
              模型
            </div>
            <CoordinatorConfigBar
              variant="menu"
              engines={config.engines}
              engine={config.engine}
              defaultEngine={config.defaultEngine}
              model={config.model}
              fastModel={config.fastModel}
              visionModel={config.visionModel}
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
            />
          </div>
        </>
      )}
    </div>
  )
}
