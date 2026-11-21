import type { AssistantChatMessage } from '../../stores/assistantStore'
import { useI18n } from '../../i18n'
import Spinner from '../Spinner'
import { DigitalPersonConversationDialog } from './DigitalPersonDelegationDialog'
import { readDigitalPersonUiReply } from './digitalPersonUiReply'
import { useDigitalPersonUiActions } from './useDigitalPersonUiActions'

export default function DigitalPersonWorkbenchActions({ mainSessionId, sessionId, reply }: {
  mainSessionId?: string
  sessionId: string
  reply?: AssistantChatMessage
}) {
  const { t } = useI18n()
  const isMain = mainSessionId === sessionId
  const { panel, opening, issue, close, finishClosing } = useDigitalPersonUiActions(isMain, sessionId, isMain ? reply : undefined)
  const unverified = mainSessionId === undefined && reply?.status === 'succeeded' && readDigitalPersonUiReply(reply.content).action
  return <>
    {opening && <div role="status"><Spinner size={16} /> {t('common.loading')}</div>}
    {!opening && (issue || unverified) && <div className="assistant-chat-error" role="alert">{t(`digitalPersonUi.${issue || 'detailUnavailable'}`)}</div>}
    {panel && !panel.closing && <DigitalPersonConversationDialog key={panel.id}
      projectId={panel.projectId} initialSessionId={panel.sessionId} initialHistory={panel.initialHistory}
      title={panel.title} onClose={() => { close(); finishClosing(panel.id) }} />}
  </>
}
