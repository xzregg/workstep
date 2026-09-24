import Icon from './Icon'
import MessageIdPopover from './MessageIdPopover'
import ProcessTrace from './ProcessTrace'
import {
  formatConversationDateTime,
  formatDurationBetween,
  toMilliseconds,
} from '../utils/datetime'
import { useI18n } from '../i18n'
import { useUserSettingsStore } from '../stores/userSettingsStore'

/* ══════════════════════════════════════════
   MessageMetaBar — shared LLM message meta row
   (timestamp + process trace + session id + prompt
   viewer link). Used by the task conversation and the
   AI flow-design chat so both render the same header.
   ══════════════════════════════════════════ */

function hasCompactedEvent(events?: any[]): boolean {
  return (events || []).some((event) => (
    event?.type === 'compacted'
    || (event?.type === 'CUSTOM' && event?.name === 'workstep.compacted')
  ))
}

function hasIdleTimeoutEvent(events?: any[]): boolean {
  return (events || []).some((event) => (
    event?.type === 'status' && event?.data?.status === 'idle_timeout'
    || event?.type === 'CUSTOM' && event?.name === 'workstep.status'
      && event?.value?.status === 'idle_timeout'
    || (event?.type === 'RUN_STARTED' || event?.type === 'RUN_ERROR')
      && event?.status === 'idle_timeout'
  ))
}

function hasTurnDoneEvent(events?: any[]): boolean {
  return (events || []).some((event) => (
    event?.type === 'status' && event?.data?.status === 'done'
    || event?.type === 'RUN_FINISHED' && event?.status === 'done'
  ))
}

export interface MessageMetaBarProps {
  createdAt?: string | number | null
  startedAt?: string | number | null
  endedAt?: string | number | null
  running?: boolean
  events?: any[]
  prompt?: string | null
  /** WorkStep 会话 ID：元信息栏显示「会话 ID」入口，点击复制完整 ID；悬停该入口弹出 ID 面板。 */
  sessionId?: string | null
  /** 消息 ID：与 sessionId 一起显示在「会话 ID」悬停面板中。 */
  messageId?: string | null
  /** 该消息所属步骤的产物输出轮次。 */
  artifactRound?: number | null
  onViewPrompt: (prompt: string) => void
  /** Terminal message status shown as a pill (cancelled/stopped/failed). */
  status?: 'cancelled' | 'stopped' | 'failed'
  onRetryFailedMessage?: () => void
  retryingFailedMessage?: boolean
  /** Render this message as a manual review header (no engine process trace). */
  reviewMode?: boolean
  /** Manual review outcome used to color the badge (passed=green, others=red). */
  reviewStatus?: string
  onSetReviewComplete?: () => void
  settingReviewComplete?: boolean
  /** True when the step insert queue has messages waiting to be sent. */
  pendingInserts?: boolean
  eventSummary?: {
    thought_characters?: number
    commentary_characters?: number
    tool_count?: number
  }
  eventDetail?: {
    available?: boolean
    loaded?: boolean
    loading?: boolean
    error?: string
  }
  onLoadEventDetails?: () => void
  /** 项目 id：把 read/edit 工具目标解析为可预览的项目文件链接。 */
  projectId?: string
}

export default function MessageMetaBar({
  createdAt,
  startedAt,
  endedAt,
  running = false,
  events,
  prompt,
  sessionId,
  messageId,
  artifactRound,
  onViewPrompt,
  status,
  onRetryFailedMessage,
  retryingFailedMessage = false,
  reviewMode = false,
  reviewStatus,
  onSetReviewComplete,
  settingReviewComplete = false,
  pendingInserts = false,
  eventSummary,
  eventDetail,
  onLoadEventDetails,
  projectId,
}: MessageMetaBarProps) {
  const { t, locale } = useI18n()
  const openMode = useUserSettingsStore((state) => state.openMode)
  const eventStartedAt = (events || []).reduce<number | null>((earliest, event) => {
    const timestamp = toMilliseconds(event?.created_at ?? event?.timestamp)
    if (timestamp === null) return earliest
    return earliest === null ? timestamp : Math.min(earliest, timestamp)
  }, null)
  const displayStartedAt = startedAt || createdAt || eventStartedAt
  const eventSessionId = (events || []).reduce<string | null>((found, event) => {
    if (found) return found
    const sid = event?.session_id
      ?? event?.data?.session_id
      ?? (event?.type === 'CUSTOM' ? event?.value?.session_id : undefined)
    return typeof sid === 'string' && sid.trim() ? sid : null
  }, null)
  const displaySessionId = sessionId || eventSessionId
  const setReviewCompleteButton = onSetReviewComplete ? (
    <button
      type="button"
      className="chat-message-action"
      disabled={settingReviewComplete}
      onClick={onSetReviewComplete}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '0 5px', minHeight: 18, color: 'var(--success)', fontSize: 'inherit' }}
    >
      {settingReviewComplete
        ? <span className="task-status-spinner" aria-hidden="true" />
        : <Icon name="check" size={11} />}
      {t('taskDetail.setStepComplete')}
    </button>
  ) : null

  return reviewMode ? (
    <div style={{
      width: '100%', minHeight: 30,
      padding: '6px 0',
      color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))',
      borderBottom: '1px solid var(--border-soft)',
      display: 'flex', alignItems: 'center', gap: 8,
      fontVariantNumeric: 'tabular-nums',
    }}>
      {!running && endedAt && (
        <span style={{ color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))', flexShrink: 0 }}>
          {t('taskDetail.reviewDuration', {
            duration: formatDurationBetween(displayStartedAt, endedAt, t) || '',
          })}
        </span>
      )}
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        height: 18, padding: '0 7px', borderRadius: 9,
        background: reviewStatus === 'passed'
          ? 'rgba(46,160,67,0.08)'
          : 'rgba(217,45,32,0.08)',
        color: reviewStatus === 'passed' ? 'var(--success)' : 'var(--danger)',
        fontSize: 'calc(11px * var(--font-scale))', flexShrink: 0,
        whiteSpace: 'nowrap',
      }}>
        <Icon name={reviewStatus === 'passed' ? 'check' : 'x'} size={11} strokeWidth={2.2} />
        {t('taskDetail.manualReview')}
      </span>
      {setReviewCompleteButton}
      {artifactRound && artifactRound > 0 && (
        <span style={{ marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {t('taskDetail.artifactRound', { round: artifactRound })}
        </span>
      )}
      <span
        title={formatConversationDateTime(displayStartedAt, Date.now(), locale)}
        style={{ marginLeft: artifactRound && artifactRound > 0 ? 0 : 'auto', minHeight: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 }}
      >
        {formatConversationDateTime(displayStartedAt, Date.now(), locale)}
      </span>
    </div>
  ) : (
    <div style={{
      width: '100%', minHeight: 30,
      paddingBottom: 6,
      color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))',
      borderBottom: '1px solid var(--border-soft)',
    }}>
      <ProcessTrace
        events={events || []}
        running={running}
        stopped={status === 'cancelled' || status === 'stopped'}
        startedAt={displayStartedAt}
        endedAt={endedAt}
        projectId={projectId}
        compact
        eventSummary={eventSummary}
        detailsAvailable={eventDetail?.available}
        detailsLoaded={eventDetail?.loaded}
        detailsLoading={eventDetail?.loading}
        detailsError={eventDetail?.error}
        onLoadDetails={onLoadEventDetails}
        summaryMeta={(
          <span
            className="message-meta-details"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            style={{
              marginLeft: 'auto', minWidth: 0,
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}
          >
            {status === 'failed' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span
                  title={t('meta.failedTitle')}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    height: 18, padding: '0 7px', borderRadius: 9,
                    border: '1px solid rgba(217,45,32,0.45)',
                    background: 'rgba(217,45,32,0.08)',
                    color: 'var(--danger)', fontSize: 'calc(11px * var(--font-scale))', flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Icon name="x" size={8} strokeWidth={2.6} />
                  {t('trace.failed')}
                </span>
                {onRetryFailedMessage && (
                  <button
                    type="button"
                    className="chat-message-action"
                    title={t('footer.retryFailedMessageTitle')}
                    disabled={retryingFailedMessage}
                    onClick={onRetryFailedMessage}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '0 4px', minHeight: 18, color: 'var(--danger)', fontSize: 'inherit' }}
                  >
                    {retryingFailedMessage
                      ? <span className="task-status-spinner" aria-hidden="true" />
                      : <Icon name="rotate-ccw" size={11} />}
                    {t('footer.restart')}
                  </button>
                )}
              </span>
            ) : null}
            {setReviewCompleteButton}
            {hasIdleTimeoutEvent(events) && (
              <span
                title={t('meta.idleTimeoutTitle')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  height: 18, padding: '0 7px', borderRadius: 9,
                  background: 'color-mix(in oklab, var(--warn), transparent 86%)',
                  color: 'var(--warn-text)', fontSize: 'calc(11px * var(--font-scale))', flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                <Icon name="clock" size={11} strokeWidth={2.2} />
                {t('meta.idleTimeout')}
              </span>
            )}
            {running && hasTurnDoneEvent(events) && !hasIdleTimeoutEvent(events) && pendingInserts && (
              <span
                title={t('meta.waitingInjectionTitle')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  height: 18, padding: '0 7px', borderRadius: 9,
                  background: 'color-mix(in oklab, var(--accent), transparent 88%)',
                  color: 'var(--accent)', fontSize: 'calc(11px * var(--font-scale))', flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                <Icon name="clock" size={11} strokeWidth={2.2} />
                {t('meta.waitingInjection')}
              </span>
            )}
            {hasCompactedEvent(events) && (
              <span
                title={t('meta.compactedTitle')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  height: 18, padding: '0 7px', borderRadius: 9,
                  background: 'color-mix(in oklab, var(--meta), transparent 88%)',
                  color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))', flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                <Icon name="undo-2" size={11} strokeWidth={2.2} />
                {t('meta.compacted')}
              </span>
            )}
            {/* 「会话 ID」入口 + 悬停下拉面板（自带触发按钮，无 ID 时不渲染）。
                开发模式下面板内出现「打开」按钮，reveal 会话 JSONL 日志目录。 */}
            <MessageIdPopover
              messageId={messageId}
              sessionId={displaySessionId}
              projectId={projectId}
              openEnabled={openMode}
            />
            {openMode && prompt && (
              <button
                type="button"
                className="meta-link-btn chat-message-action"
                title={t('meta.viewPromptTitle')}
                onClick={() => onViewPrompt(prompt)}
                style={{
                  fontSize: 'calc(11px * var(--font-scale))', color: 'var(--accent)',
                  display: 'inline-flex', alignItems: 'center',
                  minHeight: 24, flexShrink: 0,
                }}
              >
                {t('meta.viewPrompt')}
              </button>
            )}
            {artifactRound && artifactRound > 0 && (
              <span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                {t('taskDetail.artifactRound', { round: artifactRound })}
              </span>
            )}
            <span
              title={formatConversationDateTime(displayStartedAt, Date.now(), locale)}
              style={{ minHeight: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
            >
              {formatConversationDateTime(displayStartedAt, Date.now(), locale)}
            </span>
          </span>
        )}
      />
    </div>
  )
}
