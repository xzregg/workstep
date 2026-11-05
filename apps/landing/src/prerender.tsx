import { renderToStaticMarkup } from 'react-dom/server'
import App from './App'
import { I18nProvider } from './i18n'

// Use the actual homepage, keeping crawler content aligned with the visible UI.
// The browser mounts the interactive app with its own language and theme.
export function renderHomepage(): string {
  return renderToStaticMarkup(<I18nProvider><App /></I18nProvider>)
}
