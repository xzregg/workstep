import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFile } from 'node:fs/promises'
import { installDomEnvironment } from './helpers/domEnv'

import PlanChecklist from '../src/components/PlanChecklist.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

function render(detail?: string) {
  return renderToStaticMarkup(
    <I18nProvider>
      <PlanChecklist plan={{
        entries: [{
          content: '环境检查',
          ...(detail ? { detail } : {}),
          priority: 'medium',
          status: 'pending',
        }],
        completed: 0,
        total: 1,
      }} />
    </I18nProvider>,
  )
}

test('offers a per-step details disclosure only when detail exists', () => {
  const withDetail = render('检查运行环境与依赖版本')
  assert.match(withDetail, /class="plan-detail-toggle"/)
  assert.match(withDetail, /class="plan-detail-chevron"/)
  assert.doesNotMatch(withDetail, />详情</)
  assert.match(withDetail, /aria-expanded="false"/)
  assert.match(
    withDetail,
    /class="plan-detail-toggle"[^>]*>[\s\S]*class="plan-label"[^>]*>环境检查<\/span>/,
  )

  assert.doesNotMatch(render(), /class="plan-detail-toggle"/)
})

test('completed plan icons are green while pending icons stay muted', async () => {
  const { window } = installDomEnvironment()
  try {
    const stylesheet = document.head.appendChild(document.createElement('style'))
    const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
    stylesheet.textContent = css.replace(/^@import[^;]+;/gm, '')
    const container = document.body.appendChild(document.createElement('div'))
    container.innerHTML = renderToStaticMarkup(
      <I18nProvider>
        <PlanChecklist plan={{
          entries: [
            { content: '已完成', priority: 'medium', status: 'completed' },
            { content: '待处理', priority: 'medium', status: 'pending' },
          ],
          completed: 1,
          total: 2,
        }} />
      </I18nProvider>,
    )
    // Happy DOM does not compute SVG styles; keep the rendered classes and
    // ancestry on HTML probes to verify the actual stylesheet cascade.
    for (const icon of container.querySelectorAll('svg.plan-icon')) {
      const probe = document.createElement('span')
      probe.className = icon.getAttribute('class') || ''
      icon.replaceWith(probe)
    }
    const completedIcon = container.querySelector('.plan-item.done .plan-icon.on')!
    const pendingIcon = container.querySelector('.plan-item:not(.done) .plan-icon.on')!
    assert.equal(window.getComputedStyle(completedIcon).color, '#16a34a')
    assert.equal(window.getComputedStyle(pendingIcon).color, '#86868b')
  } finally {
    await window.happyDOM.close()
  }
})
