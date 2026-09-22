interface SidebarStatusIndicatorProps {
  running?: boolean
  failed?: boolean
  completed?: boolean
  runningTitle: string
  failedTitle: string
  completedTitle: string
  size?: number
}

export default function SidebarStatusIndicator({
  running = false,
  failed = false,
  completed = false,
  runningTitle,
  failedTitle,
  completedTitle,
  size = 10.4,
}: SidebarStatusIndicatorProps) {
  if (running) {
    return (
      <span
        className="task-status-spinner"
        style={{ color: 'var(--accent)', flexShrink: 0, width: size, height: size }}
        title={runningTitle}
        aria-hidden="true"
      />
    )
  }
  if (failed) {
    return <span className="sidebar-failure-dot" title={failedTitle} aria-label={failedTitle} />
  }
  if (completed) {
    return <span className="sidebar-completion-dot" title={completedTitle} aria-label={completedTitle} />
  }
  return null
}
