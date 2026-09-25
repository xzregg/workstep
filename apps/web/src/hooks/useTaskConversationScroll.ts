import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type RefObject, type UIEvent, type WheelEvent } from 'react'
import type { LiveMessage } from '../stores/taskStore'
import {
  conversationBottomScrollTop,
  hasActiveSelectionWithin,
  isAutoShrinkClamp,
  isNearConversationBottom,
  observeContentResize,
  shouldPauseConversationFollow,
} from '../pages/taskDetailChat'
import { useComposerOverlayClearance } from './useComposerOverlayClearance'

type ScrollOptions = {
  historyMessages: unknown[]
  liveMessages: Record<string, LiveMessage>
  events: unknown[]
  content: string
  chatScrollRef?: RefObject<HTMLDivElement | null>
  chatEndRef?: RefObject<HTMLDivElement | null>
  shouldFollowMessagesRef?: MutableRefObject<boolean>
  lastProgrammaticScrollTopRef?: MutableRefObject<number>
  stepLastMessageRefs?: MutableRefObject<Record<string, HTMLDivElement | null>>
  pendingStepScrollRef?: MutableRefObject<string | null>
  hasUnreadMessages?: boolean
  onUnreadMessagesChange?: (value: boolean) => void
  onLoadOlderHistory?: () => void
}

/** Owns follow, unread, media resize, and scroll interaction for a task transcript. */
export function useTaskConversationScroll({
  historyMessages, liveMessages, events, content,
  chatScrollRef, chatEndRef, shouldFollowMessagesRef, lastProgrammaticScrollTopRef,
  stepLastMessageRefs, pendingStepScrollRef, hasUnreadMessages,
  onUnreadMessagesChange, onLoadOlderHistory,
}: ScrollOptions) {
  const localScrollRef = useRef<HTMLDivElement>(null)
  const localEndRef = useRef<HTMLDivElement>(null)
  const localFollowRef = useRef(true)
  const localProgrammaticRef = useRef(0)
  const localStepLastRef = useRef<Record<string, HTMLDivElement | null>>({})
  const localPendingStepRef = useRef<string | null>(null)
  const [localUnread, setLocalUnread] = useState(false)
  const scrollRef = chatScrollRef ?? localScrollRef
  const endRef = chatEndRef ?? localEndRef
  const followRef = shouldFollowMessagesRef ?? localFollowRef
  const programmaticRef = lastProgrammaticScrollTopRef ?? localProgrammaticRef
  const stepLastRef = stepLastMessageRefs ?? localStepLastRef
  const pendingScrollRef = pendingStepScrollRef ?? localPendingStepRef
  const lastScrollTopRef = useRef(0)
  const lastScrollHeightRef = useRef(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const [scrolledToBottom, setScrolledToBottom] = useState(true)
  const unreadMessages = hasUnreadMessages ?? localUnread
  const setUnreadMessages = useCallback((value: boolean) => {
    if (hasUnreadMessages === undefined) setLocalUnread(value)
    onUnreadMessagesChange?.(value)
  }, [hasUnreadMessages, onUnreadMessagesChange])

  const { registerOverlay, overlayPaddingBottom } = useComposerOverlayClearance({
    scrollRef, followRef, programmaticRef, scrollHeightRef: lastScrollHeightRef,
  })

  // Only message content changes trigger this effect; elapsed-time ticks do not.
  useEffect(() => {
    const container = scrollRef.current
    if (container && hasActiveSelectionWithin(
      container, container.ownerDocument.getSelection(),
    )) {
      followRef.current = false
      lastScrollHeightRef.current = container.scrollHeight
      setScrolledToBottom(false)
      setUnreadMessages(true)
      return
    }
    if (followRef.current) {
      if (container) {
        const target = conversationBottomScrollTop(container.scrollHeight, container.clientHeight)
        programmaticRef.current = target
        lastScrollHeightRef.current = container.scrollHeight
        container.scrollTop = target
        setScrolledToBottom(isNearConversationBottom(container.scrollHeight, target, container.clientHeight))
      }
      setUnreadMessages(false)
    } else {
      if (container) lastScrollHeightRef.current = container.scrollHeight
      setScrolledToBottom(false)
      setUnreadMessages(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyMessages, liveMessages, events, content])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const onMediaLoad = () => {
      if (!followRef.current) return
      const target = conversationBottomScrollTop(container.scrollHeight, container.clientHeight)
      programmaticRef.current = target
      lastScrollHeightRef.current = container.scrollHeight
      container.scrollTop = target
      setScrolledToBottom(isNearConversationBottom(container.scrollHeight, target, container.clientHeight))
    }
    container.addEventListener('load', onMediaLoad, true)
    return () => container.removeEventListener('load', onMediaLoad, true)
  }, [scrollRef, followRef, programmaticRef])

  useEffect(() => observeContentResize({
    containerRef: scrollRef,
    contentRef,
    onResize: ({ height }) => {
      const container = scrollRef.current
      if (!container || !followRef.current) return
      lastScrollHeightRef.current = height
      const target = conversationBottomScrollTop(container.scrollHeight, container.clientHeight)
      programmaticRef.current = target
      container.scrollTop = target
      setScrolledToBottom(isNearConversationBottom(container.scrollHeight, target, container.clientHeight))
    },
  }), [scrollRef, followRef, programmaticRef])

  const onWheelCapture = (event: WheelEvent<HTMLDivElement>) => {
    if (shouldPauseConversationFollow({ type: 'wheel', deltaY: event.deltaY })) {
      followRef.current = false
    }
  }
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (shouldPauseConversationFollow({ type: 'key', key: event.key })) {
      followRef.current = false
    }
  }
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget
    if (container.scrollTop <= 40) onLoadOlderHistory?.()
    const nearBottom = isNearConversationBottom(
      container.scrollHeight, container.scrollTop, container.clientHeight,
    )
    const programmaticEcho = Math.abs(container.scrollTop - programmaticRef.current) <= 1
    const autoShrinkClamp = isAutoShrinkClamp({
      scrollTop: container.scrollTop,
      prevScrollTop: lastScrollTopRef.current,
      scrollHeight: container.scrollHeight,
      prevScrollHeight: lastScrollHeightRef.current,
      clientHeight: container.clientHeight,
    })
    if (!programmaticEcho && container.scrollTop < lastScrollTopRef.current) {
      if (autoShrinkClamp) {
        programmaticRef.current = container.scrollTop
      } else if (!(
        container.scrollHeight > lastScrollHeightRef.current
        && lastScrollTopRef.current - container.scrollTop <= 2
      )) {
        followRef.current = false
      }
    }
    if (container.scrollTop >= lastScrollTopRef.current && nearBottom && !followRef.current) {
      followRef.current = true
      setUnreadMessages(false)
    }
    setScrolledToBottom(nearBottom)
    lastScrollTopRef.current = container.scrollTop
    lastScrollHeightRef.current = container.scrollHeight
  }
  const jumpToLatest = () => {
    followRef.current = true
    setUnreadMessages(false)
    const container = scrollRef.current
    if (container) {
      const target = conversationBottomScrollTop(container.scrollHeight, container.clientHeight)
      programmaticRef.current = target
      container.scrollTo({ top: target, behavior: 'smooth' })
    }
  }

  return {
    scrollRef, endRef, contentRef, stepLastRef, pendingScrollRef,
    scrolledToBottom, unreadMessages, registerOverlay, overlayPaddingBottom,
    onWheelCapture, onKeyDownCapture, onScroll, jumpToLatest,
  }
}
