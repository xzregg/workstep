import { useEffect, useState } from 'react'
import { useI18n, useLocaleStore } from '../i18n'
import Select from '../components/Select'
import { loadFontFamilyPreference, currentFontFamilyPreference, saveFontFamilyPreference, type FontFamilyPreference } from '../utils/fontFamilyPreference'
import SegmentedControl from '../components/SegmentedControl'
import SkinSettings from '../components/SkinSettings'
import { APPEARANCE_PREFERENCE_EVENT, loadFontSizePreference, saveFontSizePreference, type FontSizePreference } from '../utils/fontSizePreference'
import './AppearanceSettings.css'
import { retryAppearancePreferences, useAppearanceSyncState } from '../utils/appearancePreferences'
import Spinner from '../components/Spinner'

export default function AppearanceSettings() {
  const { t, locale, setLocale } = useI18n()
  const sync = useAppearanceSyncState()
  const language = useLocaleStore(s => s.language)
  const installed = useLocaleStore(s => s.installed)
  const languageLoading = useLocaleStore(s => s.loading)
  const languageError = useLocaleStore(s => s.error)
  useEffect(() => { void useLocaleStore.getState().refresh().catch(() => {}) }, [])
  const [fontFamily, setFontFamily] = useState(loadFontFamilyPreference)
  const [fontSize, setFontSize] = useState(loadFontSizePreference)
  useEffect(() => {
    const sync = () => {
      setFontFamily(currentFontFamilyPreference())
      setFontSize((document.documentElement.dataset.fontSize as FontSizePreference) || loadFontSizePreference())
    }
    window.addEventListener(APPEARANCE_PREFERENCE_EVENT, sync)
    return () => window.removeEventListener(APPEARANCE_PREFERENCE_EVENT, sync)
  }, [])
  const changeFontSize = (value: FontSizePreference) => {
    setFontSize(value)
    saveFontSizePreference(value)
  }
  const changeFontFamily = (value: FontFamilyPreference) => {
    setFontFamily(value)
    saveFontFamilyPreference(value)
  }
  const preferences = <section className="settings-appearance-font" aria-label={t('settings.appearanceBasicsTitle')}>
      <div className="settings-appearance-font-copy"><h2>{t('settings.appearanceBasicsTitle')}</h2></div>
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
          <Select id="appearance-language" aria-label={t('nav.language')} value={language ? 'pack:' + language.manifest.id : locale} disabled={languageLoading}
            onChange={event => setLocale(event.target.value)}>
            <option value="zh-CN">简体中文</option>
            <option value="zh-TW">繁體中文</option>
            <option value="en-US">English</option>
            <option value="ja-JP">日本語</option>
            <option value="fr-FR">Français</option>
            <option value="de-DE">Deutsch</option>
            <option value="ar">العربية</option>
            {installed.map(item => <option key={item.manifest.id} value={'pack:' + item.manifest.id}>{item.manifest.native_name} · {item.manifest.name}</option>)}
            {language && !installed.some(item => item.manifest.id === language.manifest.id) && <option value={'pack:' + language.manifest.id}>{language.manifest.native_name}</option>}
          </Select>
          {languageError && <p role="alert">{languageError}</p>}
        </div>
      </div>
    </section>
  return <div className="settings-appearance-page">
    {sync.status !== 'local' && <div className="appearance-sync-status" role={sync.status === 'error' ? 'alert' : 'status'}>
      {sync.status === 'saving' && <Spinner size={14} />}
      <span>{t(sync.status === 'error' ? 'settings.appearanceSyncFailed' : sync.status === 'saving' ? 'settings.appearanceSyncSaving' : 'settings.appearancePersonal')}</span>
      {sync.status === 'error' && <button type="button" onClick={() => void retryAppearancePreferences()}>{t('common.retry')}</button>}
    </div>}
    <SkinSettings preferences={preferences} onRefresh={() => useLocaleStore.getState().refresh()} />
  </div>
}
