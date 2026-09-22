import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from '../src/App'
import { DEMOS } from '../src/demo/demos'
import { I18nProvider } from '../src/i18n'

function renderLanding() {
  return renderToStaticMarkup(
    <I18nProvider>
      <App />
    </I18nProvider>,
  )
}

describe('landing positioning', () => {
  it('explains AI tool orchestration instead of LLM API orchestration', () => {
    const html = renderLanding()

    expect(html).toContain('别人在编排模型 API，我们在编排 AI 工具')
    expect(html).toContain('不造 Agent，编排已经能干活的 Agent')
    expect(html).toContain('编排现成 Agent 工具，不造轮子')
  })

  it('presents reciprocal, multi-person remote project collaboration', () => {
    const html = renderLanding()

    expect(html).toContain('你的项目分享给我')
    expect(html).toContain('我的项目也能分享给你')
    expect(html).toContain('多人共同推进')
    expect(html).toContain('项目仍运行在拥有者的设备上')
    expect(html).toContain('一次性邀请')
    expect(html).not.toContain('项目实时动态')
    expect(html).not.toContain('小周创建了“实现登录页”任务')
  })

  it('keeps the hero preview and all three interactive demos', () => {
    const html = renderLanding()

    expect(html).toContain('class="hero-preview"')
    expect(DEMOS.map((demo) => demo.id)).toEqual(['canvas', 'stream', 'parallel'])
    expect(html.match(/class="demo-card"/g)).toHaveLength(3)
  })

  it('places demos after the outcome features and remote sharing at the end', () => {
    const html = renderLanding()
    const featuresIndex = html.indexOf('让 AI 工具自己接着往下干')
    const demosIndex = html.indexOf('像看视频一样，看完一次完整的工作流')
    const workflowIndex = html.indexOf('不限于研发，任意流程都能编排')
    const remoteShareIndex = html.indexOf('你的项目分享给我')
    const finalCtaIndex = html.indexOf('把你正在重复的工作，变成一条会自己推进的流程')

    expect(featuresIndex).toBeGreaterThan(-1)
    expect(demosIndex).toBeGreaterThan(featuresIndex)
    expect(workflowIndex).toBeGreaterThan(demosIndex)
    expect(remoteShareIndex).toBeGreaterThan(workflowIndex)
    expect(finalCtaIndex).toBeGreaterThan(remoteShareIndex)
  })

  it('keeps the workflow examples focused on templates instead of raw JSON', () => {
    const html = renderLanding()

    expect(html).not.toContain('.workstep/steps.json')
    expect(html).not.toContain('&quot;requirements&quot;')
  })
})
