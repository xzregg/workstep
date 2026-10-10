import { useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import { useI18n } from '../i18n'
import Icon from './Icon'
import { NavigationHeaderContext } from './NavigationHeaderContext'
import { BrandIcon } from './BrandIcon'

export default function ResponsiveNavigation({ children, title, onNew, style, className, dismissSignal, newDisabled = false, headerRight, showBrandIcon = true }: {
  children: ReactNode; title: string; onNew: () => void; style?: CSSProperties; className?: string; dismissSignal?: string; newDisabled?: boolean; headerRight?: ReactNode; showBrandIcon?: boolean
}) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const headerLeft = useContext(NavigationHeaderContext)
  const displayTitle = showBrandIcon && /^workstep$/i.test(title) ? 'WorkStep' : title
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const navigationType = useNavigationType()
  const preserveNavigationDrawer = Boolean(
    (location.state as { preserveNavigationDrawer?: boolean } | null)?.preserveNavigationDrawer,
  )
  const ref = useRef<HTMLElement>(null)
  useOverlay(compact && open, () => setOpen(false), ref)
  useEffect(() => {
    if (navigationType === 'POP' || preserveNavigationDrawer) return
    setOpen(false)
  }, [location.key, navigationType, preserveNavigationDrawer])
  useEffect(() => { setOpen(false) }, [compact, dismissSignal])
  return <>
    <header className={`mobile-header${headerLeft ? ' mobile-header--device' : ''}`} >
      <div className="mobile-header-left">
      <button aria-label={t('mobile.openNavigation')} aria-expanded={open} aria-controls="workstep-navigation" onClick={() => setOpen(true)}><Icon name="menu" size={21} /></button>
      {headerLeft}
      </div>
      <span className="mobile-header-title" title={displayTitle}>{showBrandIcon && displayTitle === 'WorkStep' && <BrandIcon size={18}/>}<span>{displayTitle}</span></span>
      <div className="mobile-header-actions">
        {headerRight}
        <button aria-label={t('mobile.newChat')} disabled={newDisabled} onClick={onNew}><Icon name="plus" size={21} /></button>
      </div>
    </header>
    {compact && open && <div className="mobile-overlay-backdrop navigation-backdrop" onClick={() => setOpen(false)} />}
    <aside id="workstep-navigation" ref={ref} style={style} className={`responsive-navigation${className ? ` ${className}` : ''}${open ? ' is-open' : ''}`}
      role={compact && open ? 'dialog' : undefined} aria-modal={compact && open ? true : undefined}
      aria-label={t('mobile.navigation')} inert={compact && !open ? true : undefined} tabIndex={-1}>
      {compact && <button className="navigation-close" aria-label={t('common.close')} onClick={() => setOpen(false)}><Icon name="x" size={20} /></button>}
      {children}
    </aside>
  </>
}
