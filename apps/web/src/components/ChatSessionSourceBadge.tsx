import { useI18n } from '../i18n'
import './ChatSessionSourceBadge.css'

export default function ChatSessionSourceBadge({ source, platform, botName }: {
  source?: 'chat' | 'channel'
  platform?: string | null
  botName?: string | null
}) {
  const { t } = useI18n()
  if (source !== 'channel') return null
  const platformLabel = platform === 'wecom' ? t('channelBot.wecom')
    : platform === 'dingtalk' ? t('channelBot.dingtalk') : t('chatSession.channelSource')
  return <span className="chat-session-source-badge" title={botName ? `${platformLabel} · ${botName}` : platformLabel}>
    {botName || platformLabel}
  </span>
}
