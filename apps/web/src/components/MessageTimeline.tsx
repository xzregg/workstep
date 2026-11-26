import { memo, Profiler, type ProfilerOnRenderCallback, type ReactElement } from 'react'
import { runtimeMark } from '../utils/runtimeDiagnostics'
import ProposedPlanMessage from './ProposedPlanMessage'
import type { MessageTimelineEvent } from '../utils/messageTimeline'

interface MessageTimelineProps {
  content: string
  /** Process data is consumed separately by ProcessTrace, never as body text. */
  events: MessageTimelineEvent[]
  streaming?: boolean
  projectId?: string
  suppressTextPlan?: boolean
}

/**
 * 正文始终使用同一个 Markdown 实例，过程事件由现有过程面板展示。
 * 历史消息的 content（字符串按值比较）与 events（引用不变）都稳定，
 * 流式更新沿用 MarkdownMessage 的吐字、选区和高度管理。
 */
function MessageTimeline({
  content,
  streaming = false,
  projectId,
  suppressTextPlan = false,
}: MessageTimelineProps) {
  // Process events are displayed by ProcessTrace. Their rolling window and
  // history snapshots are not a second source of body text: rebuilding text
  // runs from them remounts Markdown/reveal state at thinking/tool boundaries.
  return profileTimeline(<div className="llm-message-timeline">
    <ProposedPlanMessage content={content} streaming={streaming} projectId={projectId} suppressPlan={suppressTextPlan} />
  </div>)
}

const measure: ProfilerOnRenderCallback = (_id, _phase, duration, _baseDuration, startedAt) => {
  runtimeMark('chat-react-render', startedAt, duration)
}

function profileTimeline(timeline: ReactElement) {
  return import.meta.env?.MODE === 'profile'
    ? <Profiler id="MessageTimeline" onRender={measure}>{timeline}</Profiler>
    : timeline
}

export default memo(MessageTimeline)
