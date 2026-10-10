import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import ProblemFeedbackSettings from '../src/components/ProblemFeedbackSettings'

test('feedback opens the GitHub bug form in a separate browser page', () => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  const html = renderToStaticMarkup(<I18nProvider><ProblemFeedbackSettings /></I18nProvider>)
  assert.match(html, /反馈问题/)
  assert.match(html, /href="https:\/\/github.com\/xzregg\/workstep\/issues\/new\?template=bug_report.yml"/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
})
