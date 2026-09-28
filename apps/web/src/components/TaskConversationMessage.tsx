import type { MutableRefObject } from 'react'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import type { ActionProposal } from '../api/client'
import type { TaskDetailViewProps } from './TaskDetailView'
import { useI18n } from '../i18n'
import { CoordinatorProposalCard } from './CoordinatorProposalCard'
import ChatMessageBubble from './ChatMessageBubble'
import StreamingStatusText from './StreamingStatusText'
import MessageMetaBar from './MessageMetaBar'
import MessageResponseFooter, { usageFromEvents } from './MessageResponseFooter'
import { stripA2uiBlocks } from '../utils/a2ui'
import ReviewDecisionActions from './ReviewDecisionActions'
import MarqueeText from './MarqueeText'
import TaskMessageArtifacts from './TaskMessageArtifacts'
import Textarea from './Textarea'
import Button from './Button'
import { displayUserDetail, displayUserSender } from '../utils/actorDisplay'
import { formatConversationDateTime } from '../utils/datetime'
import { artifactsForMessage } from '../pages/taskArtifactRules'
import {
  canRetryFailedExecutionMessage,
  canRestartStoppedExecutionMessage,
  failedExecutionCompletionRound,
  isLostEngineSessionError,
  liveExecutionStatus,
  messageSessionId,
  resolveMessageError,
  stepAvatarText,
} from '../pages/taskDetailChat'
import { canCompleteStoppedReview, isManualReviewMessage,
  isMessageReviewActionable, resolveMessageReview, reviewActorLabel } from '../pages/taskReviewRules'

const EMPTY_EVENTS: never[] = []

function terminalMessageStatus(status?: string) {
  return status === 'cancelled' || status === 'stopped' || status === 'failed'
    ? status
    : undefined
}

interface TaskConversationMessageProps extends Pick<TaskDetailViewProps,
  | 'task'
  | 'steps'
  | 'stepProgress'
  | 'reviews'
  | 'artifacts'
  | 'locale'
  | 'onOpenArtifact'
  | 'sessionIdForStep'
  | 'onSetFailedExecutionComplete'
  | 'onRestartStepWithFreshSession'
  | 'restartingStepKeys'
  | 'onPromptChange'
  | 'onSend'
  | 'chatInputRef'
  | 'onA2uiAction'
  | 'onInteractionRespond'
  | 'onLoadMessageEvents'
  | 'stepInserts'
  | 'livePromptOverrides'
  | 'onViewingPromptChange'
  | 'onRetryFailedMessage'
  | 'retryingFailedMessageIds'
  | 'reviewActionPending'
  | 'onReviewAction'
  | 'reviewComment'
  | 'onReviewCommentChange'
  | 'projectId'
  | 'executionStepModel'
  | 'onProposalOverride'
  | 'proposalOverrides'
> {
  message: any
  canChat: boolean
  latestStepMessageIds: Map<string, string>
  latestExecutionMessageIds: Map<string, string>
  stepLastRef: MutableRefObject<Record<string, HTMLDivElement | null>>
}

export default function TaskConversationMessage({
  message,
  canChat,
  latestStepMessageIds,
  latestExecutionMessageIds,
  stepLastRef,
  task,
  steps,
  stepProgress,
  reviews,
  artifacts,
  locale,
  onOpenArtifact,
  sessionIdForStep,
  onSetFailedExecutionComplete,
  onRestartStepWithFreshSession,
  restartingStepKeys,
  onPromptChange,
  onSend,
  chatInputRef,
  onA2uiAction,
  onInteractionRespond,
  onLoadMessageEvents,
  stepInserts,
  livePromptOverrides,
  onViewingPromptChange,
  onRetryFailedMessage,
  retryingFailedMessageIds,
  reviewActionPending,
  onReviewAction,
  reviewComment,
  onReviewCommentChange,
  projectId,
  executionStepModel,
  onProposalOverride,
  proposalOverrides,
}: TaskConversationMessageProps) {
  const { t } = useI18n()
  const localUserName = useUserSettingsStore((state) => state.userName)
  const stepKey =
    message.context_step_key ||
    message.step_key ||
    'unknown'
  const msgs = [message]
  const stepInfo = steps.find(
    (s: any) => s.key === stepKey,
  )
  const stepLabel =
    message.channel === 'coordinator'
      ? t('aiFlow.agent')
      : stepInfo?.label || stepKey
  return (
    <div className="task-conversation-message">
      {msgs.map(
        (msg: any, i: number) => {
          const isUser =
            msg.role === 'user'
          const isSystem =
            msg.role === 'system'
          const isReview =
            msg.channel ===
              'review' ||
            msg.role === 'review'
          const isCoordinator =
            msg.channel ===
              'coordinator'
          const isLiveInsert =
            !isCoordinator &&
            msg.role === 'user' &&
            msg.run_id === msg.id
          const msgStepIndex =
            steps.findIndex(
              (s: any) =>
                s.key === stepKey,
            )
          const msgStepStatus =
            msgStepIndex >= 0
              ? stepProgress[
                  msgStepIndex
                ]?.status
              : undefined
          const msgReview =
            resolveMessageReview(
              msg,
              reviews,
            )
          const failedCompletionRound = onSetFailedExecutionComplete
            ? failedExecutionCompletionRound(
                msg, artifacts,
                ['cancelled', 'stopped'].includes(msg.run_status)
                  ? latestExecutionMessageIds.get(stepKey)
                  : latestStepMessageIds.get(stepKey),
                task?.status, msgStepStatus,
              )
            : null
          const msgReviewPending =
            isMessageReviewActionable(
              msg,
              reviews,
              msgStepStatus,
            )
          const isLastExecutionResponse =
            !isUser &&
            !isReview &&
            !isCoordinator &&
            !isSystem &&
            ['succeeded', 'completed'].includes(
              msg.run_status,
            ) &&
            !msgs.slice(i + 1).some(
              (later) =>
                later.role === 'assistant' &&
                later.channel === 'execution',
            )
          const isCompletedExecutionResponse =
            !isUser &&
            !isReview &&
            !isCoordinator &&
            !isSystem &&
            ['succeeded', 'completed'].includes(msg.run_status)
          const messageArtifactRound =
            msg.artifact_round ?? msgReview?.artifact_round
          const msgArtifacts =
            isReview || isCompletedExecutionResponse
              ? messageArtifactRound
                ? artifactsForMessage(
                    artifacts,
                    stepKey,
                    messageArtifactRound,
                  )
                : isLastExecutionResponse
                  ? (() => {
                  const stepArtifacts = artifacts.filter(
                    (artifact) => artifact.step_key === stepKey,
                  )
                  const selected = stepArtifacts.filter(
                    (artifact) => artifact.is_selected,
                  )
                  const latest = stepArtifacts.filter(
                    (artifact) => artifact.is_latest,
                  )
                  return selected.length ? selected : latest
                    })()
                  : []
              : []
          const processEvents =
            Array.isArray(
              msg.events,
            )
              ? msg.events
              : EMPTY_EVENTS
          const isManualReview =
            isReview &&
            isManualReviewMessage(
              msg,
              reviews,
            )
          const sender = isUser
            ? displayUserSender(
                msg.author_name,
                localUserName,
                t('aiFlow.me'),
                t('aiFlow.historicalUser'),
              )
            : isSystem
              ? t(
                  'taskDetail.system',
                )
              : isCoordinator
                ? t('aiFlow.agent')
                : isManualReview
                  ? `${stepLabel} · ${t('taskDetail.manualReview')}`
                  : stepLabel
          const initials =
            isUser || isSystem
              ? sender.slice(0, 2)
              : isCoordinator
                ? t(
                    'aiFlow.agentInitials',
                  )
                : stepAvatarText(
                    stepLabel,
                    t,
                  )
          const senderColor =
            isUser
              ? 'var(--accent)'
              : isSystem
                ? 'var(--warn)'
                : isReview
                  ? (stepInfo?.color ||
                      'var(--warn)')
                  : isCoordinator
                    ? 'var(--ai-assistant)'
                    : (stepInfo?.color ||
                        'var(--fg)')
          const reviewLine =
            isManualReview
              ? t(
                  'taskDetail.manualReview',
                )
              : undefined
          const reviewActor = msgReview
            ? reviewActorLabel(msgReview)
            : undefined
          const messageContent =
            isReview &&
            msgReview?.decision
              ? [
                  reviewLine,
                  msgReview.status ===
                  'passed'
                    ? t(
                        'taskDetail.reviewPassed',
                      )
                    : msgReview.status ===
                        'terminated'
                      ? t(
                          'taskDetail.reviewTerminated',
                        )
                    : t(
                        'taskDetail.reviewRejected',
                      ),
                  reviewActor
                    ? t('taskDetail.reviewedBy', { name: reviewActor })
                    : undefined,
                  msgReview.decision_comment,
                ]
                  .filter(
                    Boolean,
                  )
                  .join('\n')
              : reviewLine
                ? `${reviewLine}\n${msg.content || ''}`
                : msg.content || ''

          return (
            <ChatMessageBubble
              key={i}
              role={
                isSystem
                  ? 'system'
                  : isReview
                    ? 'review'
                    : isUser
                      ? 'user'
                      : 'assistant'
              }
              sender={sender}
              senderTitle={
                isUser
                  ? displayUserDetail(
                      msg.author_name,
                      msg.author_device_name,
                      t('aiFlow.historicalUser'),
                      msg.author_username,
                    )
                  : undefined
              }
              initials={initials}
              color={senderColor}
              content={messageContent}
              projectId={projectId}
              error={resolveMessageError(processEvents) || undefined}
              errorActions={(() => {
                const msgError = resolveMessageError(processEvents)
                if (
                  !onRestartStepWithFreshSession
                  || !isLostEngineSessionError(msgError)
                ) {
                  return undefined
                }
                const restarting = (restartingStepKeys ?? []).includes(stepKey)
                return (
                  <div className="task-message-lost-session">
                    <span className="task-message-lost-session-hint">
                      {t('taskDetail.lostSessionHint')}
                    </span>
                    <div>
                      <Button
                        size="sm"
                        loading={restarting}
                        disabled={restarting}
                        onClick={() => onRestartStepWithFreshSession(stepKey)}
                      >
                        {restarting
                          ? t('taskDetail.lostSessionRestarting')
                          : t('taskDetail.lostSessionRestart')}
                      </Button>
                    </div>
                  </div>
                )
              })()}
              streaming={
                msg.run_status ===
                'running'
              }
              badge={
                isReview ? (
                  <span
                    title="Review"
                    aria-label={t(
                      'taskDetail.reviewBadgeAria',
                    )}
                  >
                    R
                  </span>
                ) : undefined
              }
              onEdit={
                canChat && isUser && onPromptChange && onSend
                  ? (content) => {
                      // Handle edit user message — parent should provide
                      onPromptChange(content)
                      chatInputRef?.current?.focus()
                    }
                  : undefined
              }
              onSendToInput={
                canChat && onPromptChange
                  ? (content) => {
                      onPromptChange(content)
                      chatInputRef?.current?.focus()
                    }
                  : undefined
              }
              onA2uiAction={onA2uiAction}
              events={processEvents}
              interactionsEnabled={msg.run_status === 'running'}
              onInteractionRespond={onInteractionRespond}
              rootProps={{
                ref:
                  i ===
                  msgs.length - 1
                    ? (
                        element,
                      ) => {
                        stepLastRef.current[
                          stepKey
                        ] = element
                      }
                    : undefined,
                'data-step-last-message':
                  i ===
                  msgs.length - 1
                    ? stepKey
                    : undefined,
              }}
              header={
                isUser ? (
                  <>
                    <span
                      title={
                        isCoordinator
                          ? t(
                              'taskDetail.sendToCoordinatorTitle',
                            )
                          : isLiveInsert
                            ? t(
                                'taskDetail.liveInsertTitle',
                              )
                            : t(
                                'taskDetail.stepInitialInputTitle',
                              )
                      }
                      className={`task-message-target-tag${isCoordinator ? ' task-message-target-tag--coordinator' : isLiveInsert ? ' task-message-target-tag--insert' : ''}`}
                    >
                      {isCoordinator
                        ? t(
                            'taskDetail.coordinatorTag',
                          )
                        : `@${stepLabel}`}
                    </span>
                    {sender !== t('aiFlow.me') && (
                      <MarqueeText text={sender} className="user-sender-marquee" />
                    )}
                    {formatConversationDateTime(
                      msg.started_at ||
                        msg.created_at,
                      Date.now(),
                      locale,
                    )}
                  </>
                ) : (
                  <MessageMetaBar
                    createdAt={
                      msg.created_at
                    }
                    startedAt={
                      msg.started_at
                    }
                    running={
                      msg.run_status ===
                      'running'
                    }
                    events={
                      processEvents
                    }
                    eventSummary={
                      msg.event_detail
                    }
                    eventDetail={
                      msg.event_detail
                    }
                    onLoadEventDetails={
                      msg.event_detail?.available && onLoadMessageEvents
                        ? () => onLoadMessageEvents(msg.id)
                        : undefined
                    }
                    pendingInserts={
                      (stepInserts ?? [])
                        .length > 0
                    }
                    prompt={
                      msg.prompt ||
                      livePromptOverrides?.[
                        String(msg.id)
                      ]
                    }
                    sessionId={
                      isCoordinator
                        ? (task
                            ?.coordinator_session_id ||
                            null)
                        : messageSessionId(
                            msg,
                            isReview,
                            sessionIdForStep(stepKey),
                          )
                    }
                    messageId={msg.id}
                    artifactRound={isCoordinator ? undefined : messageArtifactRound}
                    onViewPrompt={
                      onViewingPromptChange
                    }
                    status={terminalMessageStatus(
                      msg.run_status,
                    )}
                    onRetryFailedMessage={
                      onRetryFailedMessage
                      && canRetryFailedExecutionMessage(
                        msg,
                        latestStepMessageIds.get(stepKey),
                        msgStepStatus,
                        msgStepIndex >= 0 ? stepProgress[msgStepIndex]?.error : undefined,
                      )
                        ? () => onRetryFailedMessage(String(msg.id))
                        : undefined
                    }
                    onRestartStoppedMessage={
                      onRestartStepWithFreshSession
                      && canRestartStoppedExecutionMessage(
                        msg, latestExecutionMessageIds.get(stepKey),
                        task?.status, msgStepStatus,
                      )
                        ? () => onRestartStepWithFreshSession(stepKey)
                        : undefined
                    }
                    restartingStoppedMessage={(restartingStepKeys ?? []).includes(stepKey)}
                    retryingFailedMessage={(retryingFailedMessageIds ?? []).includes(String(msg.id))}
                    endedAt={
                      msg.ended_at ||
                      msgReview?.ended_at
                    }
                    reviewMode={
                      isManualReview
                    }
                    reviewStatus={
                      msgReview?.status
                    }
                    onSetReviewComplete={
                      isReview && onReviewAction
                      && canCompleteStoppedReview(
                        msgReview, reviews, artifacts,
                        task?.status, task?.active_workflow_run_id,
                        msgStepStatus,
                      )
                        ? () => onReviewAction('set-complete', msgReview, stepKey)
                        : failedCompletionRound !== null && onSetFailedExecutionComplete
                          ? () => onSetFailedExecutionComplete(String(msg.id), failedCompletionRound)
                          : undefined
                    }
                    settingReviewComplete={!!reviewActionPending}
                    projectId={projectId}
                  />
                )
              }
              showLoading={
                !isUser &&
                msg.run_status ===
                  'running' &&
                !msg.content
              }
              loading={
                !isUser &&
                msg.run_status ===
                  'running'
                  ? (
                    <StreamingStatusText
                      label={isCoordinator
                        ? t('bubble.thinking')
                        : liveExecutionStatus(
                            processEvents,
                            t,
                            (stepInserts ?? []).length > 0,
                          )}
                    />
                  )
                  : undefined
              }
              footer={
                !isUser &&
                !isSystem &&
                // 思考中（尚无正文）也展示 Token / t/s / 引擎 * 模型
                (msg.content ||
                  msg.run_status ===
                  'running') &&
                !(isReview &&
                  !msg.engine)
                  ? (
                    <MessageResponseFooter
                      content={msg.content
                        ? stripA2uiBlocks(
                          String(
                            msg.content,
                          ),
                        )
                        : ''}
                      usage={
                        msg.usage ||
                        usageFromEvents(
                          processEvents,
                        )
                      }
                      events={processEvents}
                      engine={
                        msg.engine
                      }
                      model={
                        msg.model
                      }
                      executionModel={
                        isCoordinator
                          ? undefined
                          : executionStepModel
                      }
                      startedAt={
                        msg.started_at ||
                        msg.created_at
                      }
                      endedAt={
                        msg.ended_at
                      }
                      running={
                        msg.run_status ===
                        'running'
                      }
                      stopped={
                        !isCoordinator &&
                        (msg.run_status ===
                          'cancelled' ||
                          msg.run_status ===
                            'stopped')
                      }
                      onContinueStep={
                        canChat &&
                        !isCoordinator &&
                        task?.id
                          ? () => {
                              // Parent should handle
                            }
                          : undefined
                      }
                    />
                  )
                  : undefined
              }
            >
              {onProposalOverride && projectId &&
                (msg.proposals ||
                  [])
                  .map(
                    (
                      proposal: ActionProposal,
                    ) => {
                      const currentProposal =
                        (proposalOverrides ??
                          {})[
                          proposal.id
                        ] || proposal
                      return (
                        <CoordinatorProposalCard
                          key={
                            proposal.id
                          }
                          proposal={
                            currentProposal
                          }
                          taskId={
                            task?.id ||
                            ''
                          }
                          projectId={
                            projectId ||
                            ''
                          }
                          onChanged={(
                            updated,
                          ) =>
                            onProposalOverride?.(
                              updated,
                            )
                          }
                        />
                      )
                    },
                  )}
              {!isReview &&
                <TaskMessageArtifacts artifacts={msgArtifacts} stepColor={stepInfo?.color} onOpenArtifact={onOpenArtifact} />}
              {isReview &&
                msgReviewPending && (
                  <div className="task-message-review-actions">
                    {<TaskMessageArtifacts artifacts={msgArtifacts} stepColor={stepInfo?.color} onOpenArtifact={onOpenArtifact} />}
                    {onReviewAction &&
                      msgReview!.status ===
                        'pending' && (
                        <Textarea
                          rows={2}
                          value={
                            reviewComment ??
                            ''
                          }
                          onChange={(
                            event,
                          ) =>
                            onReviewCommentChange?.(
                              event
                                .target
                                .value,
                            )
                          }
                          placeholder={t(
                            'taskDetail.reviewCommentPlaceholder',
                          )}
                        />
                      )}
                    {onReviewAction && (
                      <ReviewDecisionActions
                        status={msgReview!.status}
                        pending={!!reviewActionPending}
                        onAction={(decision) => onReviewAction?.(decision, msgReview!, stepKey)}
                      />
                    )}
                  </div>
                )}
            </ChatMessageBubble>
          )
        },
      )}
    </div>
  )
}
