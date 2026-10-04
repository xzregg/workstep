import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ChatSessionSummary } from '../api/conversations'
import { useI18n } from '../i18n'
import './SidebarConversationTabs.css'

type ConversationTab = 'chat' | 'channel'

export default function SidebarConversationTabs({ sessions, activeSessionId, onSwitch, header, open = true, children }: {
  sessions: ChatSessionSummary[]
  activeSessionId?: string | null
  onSwitch: () => void
  header?: (tabs: ReactNode, tab: ConversationTab) => ReactNode
  open?: boolean
  children: (sessions: ChatSessionSummary[]) => ReactNode
}) {
  const { t } = useI18n()
  const id = useId()
  const active = sessions.find(session => session.id === activeSessionId)
  const activeSource = active ? (active.source === 'channel' ? 'channel' : 'chat') : undefined
  const [tab, setTab] = useState<ConversationTab>(activeSource ?? 'chat')
  const currentTab = useRef(tab)
  const channelCount = sessions.filter(session => session.source === 'channel').length
  const visibleTab = channelCount ? tab : 'chat'
  useEffect(() => {
    if (!channelCount && currentTab.current !== 'chat') {
      currentTab.current = 'chat'
      setTab('chat')
      onSwitch()
    }
  }, [channelCount, onSwitch])
  useEffect(() => {
    if (activeSource && activeSource !== currentTab.current) {
      currentTab.current = activeSource
      setTab(activeSource)
      onSwitch()
    }
  }, [activeSessionId, activeSource, onSwitch])
  const choose = (next: ConversationTab) => {
    if (next !== tab) {
      currentTab.current = next
      setTab(next)
      onSwitch()
    }
  }
  const visible = sessions.filter(session => (session.source === 'channel' ? 'channel' : 'chat') === visibleTab)
  const tabs = channelCount > 0 && <div className="sidebar-conversation-tabs" role="tablist" aria-label={t('chatSession.conversationTypes')} onClick={event => event.stopPropagation()}>
      {(['chat', 'channel'] as const).map(value => <button
        key={value} type="button" role="tab" id={`${id}-${value}`}
        aria-selected={tab === value} aria-controls={`${id}-panel`} tabIndex={tab === value ? 0 : -1}
        className="sidebar-conversation-tab"
        aria-label={t(value === 'chat' ? 'chatSession.ordinaryTab' : 'chatSession.channelTab')}
        onClick={event => { event.stopPropagation(); choose(value) }}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          const next = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'channel' : value === 'chat' ? 'channel' : 'chat'
          choose(next)
          document.getElementById(`${id}-${next}`)?.focus()
        }}
      >
        {t(value === 'chat' ? 'chatSession.ordinaryTabShort' : 'chatSession.channelTabShort')}
        <span className="sidebar-conversation-tab-count">{value === 'channel' ? channelCount : sessions.length - channelCount}</span>
      </button>)}
    </div>
  return <>
    {header ? header(open ? tabs : null, visibleTab) : tabs}
    {open && <div role={channelCount ? 'tabpanel' : undefined} id={`${id}-panel`} aria-labelledby={channelCount ? `${id}-${visibleTab}` : undefined}>
      {visible.length ? children(visible) : <div className="sidebar-conversation-empty">
        {t(visibleTab === 'channel' ? 'chatSession.noChannelSessions' : 'chatSession.noOrdinarySessions')}
      </div>}
    </div>}
  </>
}
