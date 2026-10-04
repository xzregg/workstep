import { useChatListStore } from '../stores/chatSessionStore'
import { useI18n } from '../i18n'
import ChatSessionSourceBadge from './ChatSessionSourceBadge'
import './ChannelConversationContext.css'

export default function ChannelConversationContext({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const { t } = useI18n()
  const session = useChatListStore((state) => state.sessionsByProject[projectId]?.find((item) => item.id === sessionId))
  if (session?.source !== 'channel') return null
  const identity = (name?: string | null, id?: string | null) => [name, id && id !== name ? id : null].filter(Boolean).join(' · ')
  return <details className="channel-conversation-context">
    <summary><ChatSessionSourceBadge source={session.source} platform={session.channel_platform}
      botName={session.channel_name} conversationType={session.channel_conversation_type} peerName={session.channel_peer_name} />
      <span>{session.channel_conversation_id}</span></summary>
    <dl>
      <dt>{t('channelBot.robot')}</dt><dd>{session.channel_name}</dd>
      {session.channel_conversation_type === 'group' && <><dt>{t('channelBot.groupName')}</dt><dd>{session.channel_group_name || t('channelBot.unknownGroup')}</dd></>}
      <dt>{t(session.channel_conversation_type === 'group' ? 'channelBot.groupId' : 'channelBot.conversationId')}</dt><dd>{session.channel_conversation_id}</dd>
      <dt>{t('channelBot.initiator')}</dt><dd>{identity(session.channel_initiator_name, session.channel_initiator_id)}</dd>
      <dt>{t('channelBot.sender')}</dt><dd>{identity(session.channel_sender_name, session.channel_sender_id)}</dd>
    </dl>
  </details>
}
