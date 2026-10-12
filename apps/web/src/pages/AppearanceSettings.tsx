import { useState } from 'react'
import { useI18n } from '../i18n'
import SegmentedControl from '../components/SegmentedControl'
import SkinSettings from '../components/SkinSettings'
import { loadFontSizePreference, saveFontSizePreference, type FontSizePreference } from '../utils/fontSizePreference'
import './AppearanceSettings.css'

export default function AppearanceSettings() {
  const { t } = useI18n()
  const [fontSize, setFontSize] = useState(loadFontSizePreference)
  const changeFontSize = (value: FontSizePreference) => {
    setFontSize(value)
    saveFontSizePreference(value)
  }
  return <div className="settings-appearance-page">
    <SkinSettings />
    <section className="settings-appearance-font" aria-label={t('settings.fontSize')}>
      <div className="settings-appearance-font-copy"><h2>{t('settings.fontSize')}</h2><p>{t('settings.fontSizeIntro')}</p></div>
      <SegmentedControl ariaLabel={t('settings.fontSize')} value={fontSize} onChange={changeFontSize} options={[
        { value: 'small', label: t('settings.fontSizeSmall') },
        { value: 'standard', label: t('settings.fontSizeStandard') },
        { value: 'large', label: t('settings.fontSizeLarge') },
        { value: 'extraLarge', label: t('settings.fontSizeExtraLarge') },
      ]} />
    </section>
  </div>
}
