import { useI18n } from '../i18n'
import './ChatSessionSourceBadge.css'

export default function ChatSessionSourceBadge({ source, platform, botName, conversationType, peerName }: {
  source?: 'chat' | 'channel'
  platform?: string | null
  botName?: string | null
  conversationType?: 'single' | 'group' | null
  peerName?: string | null
}) {
  const { t } = useI18n()
  if (source !== 'channel') return null
  const platformLabel = platform === 'wecom' ? t('channelBot.wecom')
    : platform === 'dingtalk' ? t('channelBot.dingtalk') : t('chatSession.channelSource')
  const peerLabel = peerName && conversationType
    ? `${t(conversationType === 'single' ? 'chatSession.channelPrivate' : 'chatSession.channelGroup')} ${peerName}` : null
  const label = [platformLabel, peerLabel || botName].filter(Boolean).join(' · ')
  const fullLabel = [platformLabel, botName, peerLabel].filter(Boolean).join(' · ')
  return <span className="chat-session-source-badge" title={fullLabel} aria-label={fullLabel}>
    {label}
  </span>
}
