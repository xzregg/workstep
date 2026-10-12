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
    <section className="settings-appearance-font" aria-label={t('settings.fontSize')}>
      <h2>{t('settings.fontSize')}</h2>
      <p>{t('settings.fontSizeIntro')}</p>
      <SegmentedControl ariaLabel={t('settings.fontSize')} value={fontSize} onChange={changeFontSize} options={[
        { value: 'small', label: t('settings.fontSizeSmall') },
        { value: 'standard', label: t('settings.fontSizeStandard') },
        { value: 'large', label: t('settings.fontSizeLarge') },
        { value: 'extraLarge', label: t('settings.fontSizeExtraLarge') },
      ]} />
    </section>
    <SkinSettings />
  </div>
}
