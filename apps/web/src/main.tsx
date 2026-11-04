import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './skins/skins.css'
import App from './App.tsx'
import { I18nProvider } from './i18n'
import { initializeAppearancePreferences } from './utils/appearancePreferences'
import { zhCN } from './i18n/locales/zh-CN'
import { restoreLocalGatewayMode } from './utils/gatewayLocalFallback'
import { browserDiagnostics, installBrowserDiagnostics } from './utils/browserDiagnostics'
import { useUserSettingsStore } from './stores/userSettingsStore'
import { useProjectStore } from './stores/projectStore'

browserDiagnostics.setPrivacyContext(() => {
  const user = useUserSettingsStore.getState()
  return { identities: [user.userName, user.gatewayUsername, user.deviceName, user.deviceId,
    user.defaultProjectDirectory, ...useProjectStore.getState().projects.flatMap(project => [project.name, project.id, project.path])] }
})
installBrowserDiagnostics(window)

async function startApp() {
  await restoreLocalGatewayMode()
  await initializeAppearancePreferences()
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
