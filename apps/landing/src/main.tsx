import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import './landing.css'
import { installWebAnalytics } from './analytics'

if (import.meta.env.PROD) {
  installWebAnalytics(import.meta.env.VITE_CF_BEACON_TOKEN)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
