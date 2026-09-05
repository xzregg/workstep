interface StreamingStatusTextProps {
  label: string
  className?: string
}

export default function StreamingStatusText({
  label,
  className = '',
}: StreamingStatusTextProps) {
  return (
    <div
      className={`engine-loading-message is-shimmer${className ? ` ${className}` : ''}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    />
  )
}
