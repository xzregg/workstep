import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

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
