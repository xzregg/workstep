import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import SettingsPage from '../../../src/pages/SettingsPage'
import { I18nProvider, useLocaleStore } from '../../../src/i18n'
import '../../../src/index.css'
import '../../../src/mobile.css'

Object.assign(window, { changeHelpLanguage: () => useLocaleStore.getState().setLocale('en-US') })
createRoot(document.getElementById('root')!).render(<BrowserRouter><I18nProvider><SettingsPage
  initialSection="templates" onClose={() => {}} /></I18nProvider></BrowserRouter>)
