import { useEffect } from 'react'
import { SKIN_EVENT } from '../skins/runtime'
import type { CSSProperties, ReactNode } from 'react'
import { useCompactLayout } from '../hooks/useCompactLayout'
import MobileSheet from './MobileSheet'

/** Keeps each menu's controls shared while changing only its presentation. */
export default function ResponsivePopover({ title, onClose, children, style, className }: {
  title: string; onClose: () => void; children: ReactNode; style?: CSSProperties; className?: string
}) {
  useEffect(() => {
    window.addEventListener(SKIN_EVENT, onClose)
    return () => window.removeEventListener(SKIN_EVENT, onClose)
  }, [onClose])
  const compact = useCompactLayout()
  if (compact) return <MobileSheet open title={title} onClose={onClose}>{children}</MobileSheet>
  return <><div style={{ position: 'fixed', inset: 0, zIndex: 1300 }} onClick={onClose} />
    <div role="dialog" aria-label={title} style={style} className={className}>{children}</div>
  </>
}
