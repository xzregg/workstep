import Icon from './Icon'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { fsApi } from '../api/client'
import { copyMessageText } from './MessageResponseFooter'

/* ══════════════════════════════════════════
   MessageIdPopover — the「会话 ID」meta-row entry
   plus its dropdown panel. Hover (or tap / focus)
   on the label opens the panel; moving the mouse
   from the label into the panel keeps it open
   (the scheduled close is cancelled while the
   pointer is over the panel). Each id row has its
   own copy button; clicking the「会话 ID」label
   itself copies nothing. In developer mode the
   session row also gets an「open」button that
   reveals the JSONL event journal folder.
   ══════════════════════════════════════════ */

export interface MessageIdProps {
  messageId?: string | null
  sessionId?: string | null
  /** Host project; required to resolve + reveal the journal folder. */
  projectId?: string | null
  /** Developer mode: show the「打开」button on the session row. */
  openEnabled?: boolean
}

type CopyState = 'idle' | 'copied' | 'failed'

/** 关闭延迟：让鼠标能从「会话 ID」文字滑进面板。 */
const CLOSE_DELAY_MS = 180

function useCopy(value: string) {
  const { t } = useI18n()
  const [state, setState] = useState<CopyState>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(timer)
  }, [state])
  const copy = async () => {
    try {
      await copyMessageText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  return { state, copy, t }
}

interface IdPartProps {
  label: string; value: string; ariaLabel: string
  copyValue?: string
  /** 开发模式下 ID 行的「打开」动作：reveal JSONL 日志目录；不传则不渲染按钮。 */
  onOpenJournal?: () => Promise<void>
  openAriaLabel?: string
}

function IdRow({ label, value, ariaLabel, copyValue, onOpenJournal, openAriaLabel }: IdPartProps) {
  const { state, copy, t } = useCopy(copyValue ?? value)
  const [openState, setOpenState] = useState<CopyState>('idle')
  useEffect(() => {
    if (openState === 'idle') return
    const timer = setTimeout(() => setOpenState('idle'), 1500)
    return () => clearTimeout(timer)
  }, [openState])
  const openJournal = async () => {
    if (!onOpenJournal) return
    try {
      await onOpenJournal()
      setOpenState('copied')
    } catch {
      setOpenState('failed')
    }
  }
  const copied = state === 'copied'
  const failed = state === 'failed'
  const openCopied = openState === 'copied'
  const openFailed = openState === 'failed'
  return (
    <span
      className="msg-id-row"
      style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
    >
      <span
        style={{
          color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))',
          flexShrink: 0, whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span
        title={value}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'calc(11px * var(--font-scale))',
          color: failed ? 'var(--danger)' : copied ? 'var(--success)' : 'var(--fg-2)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: 240, minWidth: 0,
        }}
      >
        {value}
      </span>
      <button
        type="button"
        aria-label={ariaLabel}
        title={copied ? t('common.copied') : failed ? t('meta.copyFailed') : value}
        onClick={() => void copy()}
        style={{
          width: 24, height: 24, minWidth: 24, padding: 0, flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none', borderRadius: 6,
          color: failed ? 'var(--danger)' : copied ? 'var(--success)' : 'var(--muted)',
          cursor: 'pointer',
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={12} strokeWidth={2} />
      </button>
      {onOpenJournal && (
        <button
          type="button"
          className="msg-id-open"
          aria-label={openAriaLabel}
          title={openCopied ? t('meta.openJournalDone') : openFailed ? t('meta.openJournalFailed') : (openAriaLabel || '')}
          onClick={() => void openJournal()}
          style={{
            width: 24, height: 24, minWidth: 24, padding: 0, flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none', borderRadius: 6,
            color: openFailed ? 'var(--danger)' : openCopied ? 'var(--success)' : 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          <Icon name={openCopied ? 'check' : 'folder-open'} size={12} strokeWidth={2} />
        </button>
      )}
    </span>
  )
}

function hasId(value?: string | null) {
  return Boolean(value && value.trim())
}

export default function MessageIdPopover({ messageId, sessionId, projectId, openEnabled }: MessageIdProps) {
  const { t } = useI18n()
  const [visible, setVisible] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const show = () => { cancelClose(); setVisible(true) }
  const scheduleHide = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      setVisible(false)
    }, CLOSE_DELAY_MS)
  }
  useEffect(() => cancelClose, [])

  const hasSession = hasId(sessionId)
  const hasMessage = hasId(messageId)
  const messageCopyValue = hasSession && sessionId && hasMessage && messageId
    ? `${t('meta.sessionIdLabel')}: ${sessionId}\n${t('meta.messageIdLabel')}: ${messageId}`
    : messageId || ''
  // 开发模式 + 有宿主项目时，每个 ID 行的复制按钮旁多一个「打开」按钮，
  // 在文件管理器里 reveal 该会话/消息的 JSONL 事件日志目录。
  const canOpenJournal = Boolean(openEnabled && projectId)
  const openJournal = () => fsApi.openSessionJournal(
    projectId as string, hasSession ? sessionId : null, hasMessage ? messageId : null,
  ).then(() => undefined)
  if (!hasSession && !hasMessage) return null
  return (
    <span
      className="msg-id-trigger"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      onFocus={show}
      onBlur={(event) => {
        // 焦点移出整个触发器（含面板）时才关闭；Tab 进面板复制按钮不关闭。
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleHide()
      }}
      style={{
        position: 'relative', display: 'inline-flex', alignItems: 'center',
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        className="chat-message-action"
        aria-haspopup="true"
        aria-expanded={visible}
        aria-label={t('meta.idPanelTitle')}
        title={hasSession ? sessionId! : messageId!}
        onClick={() => setVisible((v) => !v)}
        style={{
          fontSize: 'calc(11px * var(--font-scale))',
          color: 'var(--meta)',
          background: 'none', border: 'none', padding: 0,
          whiteSpace: 'nowrap',
        }}
      >
        {t('meta.sessionIdLabel')}
      </button>
      {visible && (
        <span
          className="msg-id-popover"
          role="group"
          aria-label={t('meta.idPanelTitle')}
          onMouseEnter={cancelClose}
          style={{
            // top:100% + padding 桥接触发器与面板之间的空隙，鼠标移动不丢 hover
            position: 'absolute', top: '100%', right: 0, zIndex: 30,
            display: 'flex', flexDirection: 'column', paddingTop: 6,
          }}
        >
          <span
            style={{
              background: 'var(--surface)', border: '1px solid var(--border-soft)',
              borderRadius: 10, padding: '8px 10px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}
          >
            {hasSession && sessionId && (
              <IdRow
                label={t('meta.sessionIdLabel')}
                value={sessionId}
                ariaLabel={t('meta.copySessionAria')}
                onOpenJournal={canOpenJournal ? openJournal : undefined}
                openAriaLabel={t('meta.openJournalAria')}
              />
            )}
            {hasMessage && messageId && (
              <IdRow
                label={t('meta.messageIdLabel')}
                value={messageId}
                copyValue={messageCopyValue}
                ariaLabel={t('meta.copyMessageIdAria')}
                onOpenJournal={canOpenJournal ? openJournal : undefined}
                openAriaLabel={t('meta.openJournalAria')}
              />
            )}
          </span>
        </span>
      )}
    </span>
  )
}
