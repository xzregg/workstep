import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ReviewReportContent from '../src/components/ReviewReportContent.tsx'
import MarkdownMessage from '../src/components/MarkdownMessage.tsx'
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


test('historical review issues retain message and recommendation without description', async () => {
  const { window, document } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><ReviewReportContent report={{
      passed: false, score: null, summary: '## 审核总结',
      issues: [
        { severity: 'warning', category: 'security', message: '**历史问题**',
          recommendation: '- 修复建议', location: 'src/example.ts:12' },
        { severity: 'warning', category: 'missing' },
        { severity: 'error', category: 'current', description: '**标准问题**',
          suggestion: '标准建议', message: '旧字段不覆盖正文', recommendation: '旧字段不覆盖建议' },
      ],
    } as unknown as React.ComponentProps<typeof ReviewReportContent>['report']} /></I18nProvider>))
    assert.equal(document.querySelector('.review-report-summary h2')?.textContent, '审核总结')
    assert.deepEqual(Array.from(document.querySelectorAll('.review-report-issue-description strong')).map(el => el.textContent), ['历史问题', '标准问题'])
    assert.equal(document.querySelector('.review-report-issue-suggestion li')?.textContent, '修复建议')
    assert.match(document.body.textContent || '', /标准建议/)
    assert.doesNotMatch(document.body.textContent || '', /旧字段不覆盖/)
    assert.equal(document.querySelectorAll('.review-report-issue').length, 3)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('missing body can load Markdown into the same mounted component', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    for (const content of [undefined, '**加载完成**', null, '## 后续消息']) {
      await act(async () => root.render(<I18nProvider><MarkdownMessage
        content={content as unknown as string} reveal="off" /></I18nProvider>))
      assert.equal(host.textContent, content == null ? '' : content.includes('加载') ? '加载完成' : '后续消息')
    }
    assert.equal(host.querySelector('h2')?.textContent, '后续消息')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
