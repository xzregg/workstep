import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './mobile.css'
import App from './App.tsx'
import { I18nProvider } from './i18n'
import { initializeFontSizePreference } from './utils/fontSizePreference'
import { zhCN } from './i18n/locales/zh-CN'
import { restoreLocalGatewayMode } from './utils/gatewayLocalFallback'

initializeFontSizePreference()

async function startApp() {
  await restoreLocalGatewayMode()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </StrictMode>,
  )
}

void startApp().catch(() => {
  const root = document.getElementById('root')!
  root.textContent = zhCN.gatewayLocalFallbackError
  root.setAttribute('role', 'alert')
})
