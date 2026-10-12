import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useActiveSkin, useSkinPreviewing, cancelSkinPreview, saveSkin } from '../skins/runtime'
import { useI18n } from '../i18n'
import '../skins/skins.css'

export default function SkinRecovery() {
  const skin = useActiveSkin()
  const preview = useSkinPreviewing()
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const visible = preview
  useEffect(() => {
    const measure = () => document.documentElement.style.setProperty('--skin-recovery-height', visible && ref.current ? ref.current.getBoundingClientRect().height + 16 + 'px' : '0px')
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (ref.current) observer?.observe(ref.current)
    return () => { observer?.disconnect(); document.documentElement.style.removeProperty('--skin-recovery-height') }
  }, [visible, preview])
  if (!preview) return null
  return createPortal(<div ref={ref} data-skin-recovery className="skin-recovery">
    {preview && <><span>{t('skins.previewing')}</span><button onClick={() => saveSkin(skin)}>{t('skins.apply')}</button><button onClick={cancelSkinPreview}>{t('skins.cancelPreview')}</button></>}
  </div>, document.body)
}
