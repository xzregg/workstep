interface StreamingStatusTextProps {
  label: string
  className?: string
}

/**
 * 流式占位文案（"思考中"等）。
 * 可见文字 + 无停顿流光扫过（柔滑、不生硬）；不带光标——
 * 光标只属于正在吐字的正文（.markdown-stream-cursor）。
 */
export default function StreamingStatusText({
  label,
  className = '',
}: StreamingStatusTextProps) {
  return (
    <div
      className={`engine-loading-message is-shimmer${className ? ` ${className}` : ''}`}
      role="status"
      aria-live="polite"
    >
      {label}
    </div>
  )
}
