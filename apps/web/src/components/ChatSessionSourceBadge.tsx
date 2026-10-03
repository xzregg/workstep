import { useI18n } from '../i18n'
import './ChatSessionSourceBadge.css'

export default function ChatSessionSourceBadge({ source }: { source?: 'chat' | 'channel' }) {
  const { t } = useI18n()
  if (source !== 'channel') return null
  return <span className="chat-session-source-badge" title={t('chatSession.channelSourceHint')}>
    {t('chatSession.channelSource')}
  </span>
}
