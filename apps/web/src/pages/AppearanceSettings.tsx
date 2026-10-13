import { useState } from 'react'
import { useI18n, type Locale } from '../i18n'
import Select from '../components/Select'
import { loadFontFamilyPreference, saveFontFamilyPreference, type FontFamilyPreference } from '../utils/fontFamilyPreference'
import SegmentedControl from '../components/SegmentedControl'
import SkinSettings from '../components/SkinSettings'
import { loadFontSizePreference, saveFontSizePreference, type FontSizePreference } from '../utils/fontSizePreference'
import './AppearanceSettings.css'

export default function AppearanceSettings() {
  const { t, locale, setLocale } = useI18n()
  const [fontFamily, setFontFamily] = useState(loadFontFamilyPreference)
  const [fontSize, setFontSize] = useState(loadFontSizePreference)
  const changeFontSize = (value: FontSizePreference) => {
    setFontSize(value)
    saveFontSizePreference(value)
  }
  const changeFontFamily = (value: FontFamilyPreference) => {
    setFontFamily(value)
    saveFontFamilyPreference(value)
  }
  return <div className="settings-appearance-page">
    <section className="settings-appearance-font" aria-label={t('settings.appearanceBasicsTitle')}>
      <div className="settings-appearance-font-copy"><h2>{t('settings.appearanceBasicsTitle')}</h2><p>{t('settings.appearanceBasicsIntro')}</p></div>
      <div className="settings-appearance-controls">
        <div className="settings-appearance-field">
          <label htmlFor="appearance-font-family">{t('settings.fontFamily')}</label>
          <Select id="appearance-font-family" aria-label={t('settings.fontFamily')} value={fontFamily}
            onChange={event => changeFontFamily(event.target.value as FontFamilyPreference)}>
            <option value="system">{t('settings.fontFamilySystem')}</option>
            <option value="pingfang">{t('settings.fontFamilyPingfang')}</option>
            <option value="serif">{t('settings.fontFamilySerif')}</option>
          </Select>
        </div>
        <div className="settings-appearance-field settings-appearance-size">
          <span>{t('settings.fontSize')}</span>
          <SegmentedControl ariaLabel={t('settings.fontSize')} value={fontSize} onChange={changeFontSize} options={[
            { value: 'small', label: t('settings.fontSizeSmall') },
            { value: 'standard', label: t('settings.fontSizeStandard') },
            { value: 'large', label: t('settings.fontSizeLarge') },
            { value: 'extraLarge', label: t('settings.fontSizeExtraLarge') },
          ]} />
        </div>
        <div className="settings-appearance-field">
          <label htmlFor="appearance-language">{t('nav.language')}</label>
          <Select id="appearance-language" aria-label={t('nav.language')} value={locale}
            onChange={event => setLocale(event.target.value as Locale)}>
            <option value="zh-CN">简体中文</option>
            <option value="zh-TW">繁體中文</option>
            <option value="en-US">English</option>
            <option value="ja-JP">日本語</option>
          </Select>
        </div>
      </div>
    </section>
    <SkinSettings />
  </div>
}
