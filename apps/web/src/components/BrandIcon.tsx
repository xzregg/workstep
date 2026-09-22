interface BrandIconProps {
  size?: number
  className?: string
}

export function BrandIcon({ size = 18, className }: BrandIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="brand-ng" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#0071e3" />
        </linearGradient>
        <marker id="brand-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 Z" fill="#93c5fd" />
        </marker>
        <marker id="brand-arr-yellow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 Z" fill="#fbbf24" />
        </marker>
      </defs>
      <path d="M28.2 10.3 A22 22 0 0 0 11.3 39.5" stroke="#93c5fd" strokeWidth="3.5" strokeLinecap="round" markerEnd="url(#brand-arr)" />
      <path d="M15.2 46.2 A22 22 0 0 0 48.8 46.2" stroke="#93c5fd" strokeWidth="3.5" strokeLinecap="round" markerEnd="url(#brand-arr)" />
      <path d="M52.7 39.5 A22 22 0 0 0 35.8 10.3" stroke="#fbbf24" strokeWidth="3.5" strokeLinecap="round" markerEnd="url(#brand-arr-yellow)" />
      <rect x="24" y="6" width="16" height="16" rx="4.5" fill="url(#brand-ng)" />
      <rect x="8.4" y="33" width="16" height="16" rx="4.5" fill="url(#brand-ng)" />
      <rect x="39.6" y="33" width="16" height="16" rx="4.5" fill="url(#brand-ng)" />
    </svg>
  )
}
