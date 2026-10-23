import { useI18n } from '../i18n'
import './ChatSessionSourceBadge.css'
import { BOT_PLATFORMS, type BotPlatform } from '../api/channelBots'

export default function ChatSessionSourceBadge({ source, platform, conversationType }: {
  source?: 'chat' | 'channel'
  platform?: string | null
  botName?: string | null
  conversationType?: 'single' | 'group' | null
  peerName?: string | null
}) {
  const { t } = useI18n()
  if (source !== 'channel') return null
  const platformLabel = BOT_PLATFORMS.includes(platform as BotPlatform)
    ? t(`channelBot.${platform as BotPlatform}`) : t('chatSession.channelSource')
  const typeLabel = conversationType
    ? t(conversationType === 'single' ? 'chatSession.channelPrivate' : 'chatSession.channelGroup') : null
  const label = [platformLabel, typeLabel].filter(Boolean).join(' · ')
  return <span className="chat-session-source-badge" title={label} aria-label={label}>
    {label}
  </span>
}
