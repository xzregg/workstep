import { useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import { useI18n } from '../i18n'
import Icon from './Icon'
import Spinner from './Spinner'
import MobileNavigationFloat from './MobileNavigationFloat'
import { NavigationHeaderContext } from './NavigationHeaderContext'
import { BrandIcon } from './BrandIcon'
import { NavigationDismissContext } from './NavigationDismissContext'
import { MobileHeaderActionsSlot } from './MobileHeaderActions'

export default function ResponsiveNavigation({ children, title, onNew, style, className, dismissSignal, newDisabled = false, newLoading = false, showNew = true, headerRight, showBrandIcon = true, onVisibilityChange }: {
  children: ReactNode; title: string; onNew: () => void; style?: CSSProperties; className?: string; dismissSignal?: string; newDisabled?: boolean; newLoading?: boolean; showNew?: boolean; headerRight?: ReactNode; showBrandIcon?: boolean; onVisibilityChange?: (visible: boolean) => void
}) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const headerLeft = useContext(NavigationHeaderContext)
  const displayTitle = showBrandIcon && /^workstep$/i.test(title) ? 'WorkStep' : title
  const [open, setOpen] = useState(false)
  const visibilityCallback = useRef(onVisibilityChange)
  visibilityCallback.current = onVisibilityChange
  useEffect(() => { visibilityCallback.current?.(!compact || open) }, [compact, open])
  const location = useLocation()
  const navigationType = useNavigationType()
  const preserveNavigationDrawer = Boolean(
    (location.state as { preserveNavigationDrawer?: boolean } | null)?.preserveNavigationDrawer,
  )
  const headerRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (!compact) return
    const header = headerRef.current
    if (!header) return
    const left = header.querySelector<HTMLElement>('.mobile-header-left')!
    const right = header.querySelector<HTMLElement>('.mobile-header-actions')!
    // Reserve equal space on both sides, even while session actions load.
    const measure = () => {
      const bounds = header.getBoundingClientRect()
      const inset = Math.max(left.getBoundingClientRect().right - bounds.left,
        bounds.right - right.getBoundingClientRect().left) + 8
      header.style.setProperty('--mobile-header-side-space', `${inset}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    observer.observe(left)
    observer.observe(right)
    return () => observer.disconnect()
  }, [compact])
  const ref = useRef<HTMLElement>(null)
  useOverlay(compact && open, () => setOpen(false), ref)
  useEffect(() => {
    if (navigationType === 'POP' || preserveNavigationDrawer) return
    setOpen(false)
  }, [location.key, navigationType, preserveNavigationDrawer])
  useEffect(() => { setOpen(false) }, [compact, dismissSignal])
  return <>
    {compact && !window.WorkStepAndroid && !window.workstepDesktop && <MobileNavigationFloat open={open} onToggle={() => setOpen(value => !value)}/>}
    <header ref={headerRef} className={`mobile-header${headerLeft ? ' mobile-header--device' : ''}`} >
      <div className="mobile-header-left">
      <button aria-label={t('mobile.openNavigation')} aria-expanded={open} aria-controls="workstep-navigation" onClick={() => setOpen(true)}><Icon name="menu" size={21} /></button>
      {headerLeft}
      </div>
      <span className="mobile-header-title" title={displayTitle}>{showBrandIcon && displayTitle === 'WorkStep' && <BrandIcon size={18}/>}<span>{displayTitle}</span></span>
      <div className="mobile-header-actions">
        {headerRight}
        <MobileHeaderActionsSlot beforeNew />
        {showNew && <button aria-label={t('mobile.newChat')} disabled={newDisabled} aria-busy={newLoading || undefined} onClick={onNew}>{newLoading ? <Spinner size={21} /> : <Icon name="plus" size={21} />}</button>}
        <div className="mobile-header-session-actions"><MobileHeaderActionsSlot /></div>
      </div>
    </header>
    {compact && open && <div className="mobile-overlay-backdrop navigation-backdrop" onClick={() => setOpen(false)} />}
    <aside data-ui="navigation" id="workstep-navigation" ref={ref} style={style} className={`responsive-navigation${className ? ` ${className}` : ''}${open ? ' is-open' : ''}`}
      role={compact && open ? 'dialog' : undefined} aria-modal={compact && open ? true : undefined}
      aria-label={t('mobile.navigation')} inert={compact && !open ? true : undefined} tabIndex={-1}>
      {compact && <button className="navigation-close" aria-label={t('common.close')} onClick={() => setOpen(false)}><Icon name="x" size={20} /></button>}
      <NavigationDismissContext.Provider value={() => setOpen(false)}>{children}</NavigationDismissContext.Provider>
    </aside>
  </>
}
