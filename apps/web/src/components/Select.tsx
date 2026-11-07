import { forwardRef, type SelectHTMLAttributes } from 'react'
import { SearchableSelect } from '@workstep/gateway-ui/SearchableSelect'
import { useActiveSkin } from '../skins/runtime'
import { resolvedSkinLayout } from '../skins/contract'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useI18n } from '../i18n'
import MobileSheet from './MobileSheet'
import './Select.css'

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { skinRole?: 'engine' }

export default forwardRef<HTMLSelectElement, SelectProps>(function Select({ skinRole, ...props }, ref) {
  const skin = useActiveSkin()
  const compact = useCompactLayout()
  const { t } = useI18n()
  return <SearchableSelect {...props} ref={ref} skinRole={skinRole} compact={compact}
    cards={skinRole === 'engine' && resolvedSkinLayout(skin, compact).engineAppearance === 'cards'}
    loadingLabel={t('common.loading')} searchLabel={t('skins.search')} emptyLabel={t('skins.noOptions')} openLabel={t('skins.openSelect')}
    renderMobilePopup={(children, close, title) => <MobileSheet open title={title} onClose={close}>{children}</MobileSheet>} />
})
