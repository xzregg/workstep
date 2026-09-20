import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ReviewReportContent from '../src/components/ReviewReportContent.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

test('review report renders summary and issue content as Markdown blocks', async () => {
  const { window, document } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
        <ReviewReportContent
          scoreLabel="90 分"
          report={{
            passed: false,
            score: 90,
            summary: '## 总结\n\n- 第一项\n- 第二项',
            issues: [{
              severity: 'warning',
              category: 'format',
              description: '**问题**\n\n内容没有分段。',
              suggestion: '### 建议\n\n1. 增加空行\n2. 保留列表',
            }],
          }}
        />
        </I18nProvider>,
      )
    })

    assert.equal(document.querySelector('.review-report-summary h2')?.textContent, '总结')
    assert.deepEqual(
      Array.from(document.querySelectorAll('.review-report-summary li')).map((item) => item.textContent),
      ['第一项', '第二项'],
    )
    assert.equal(document.querySelector('.review-report-issue-description strong')?.textContent, '问题')
    assert.equal(document.querySelector('.review-report-issue-suggestion h3')?.textContent, '建议')
    assert.equal(document.querySelector('.review-report-score')?.textContent, '90 分')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
