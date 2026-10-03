import { useI18n } from '../i18n'
import './ChatSessionSourceBadge.css'

export default function ChatSessionSourceBadge({ source, platform, conversationType }: {
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
  const typeLabel = conversationType
    ? t(conversationType === 'single' ? 'chatSession.channelPrivate' : 'chatSession.channelGroup') : null
  const label = [platformLabel, typeLabel].filter(Boolean).join(' · ')
  return <span className="chat-session-source-badge" title={label} aria-label={label}>
    {label}
  </span>
}
