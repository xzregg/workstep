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
  it('replaces the search example with the introduction video before engine choices', () => {
    const html = renderLanding()

    expect(html).not.toContain('例如：给项目加一个搜索功能')
    expect(html).not.toContain('id="philosophy"')
    expect(html.indexOf('id="intro-video"')).toBeLessThan(html.indexOf('class="engines-strip"'))
  })

  it('explains channel bots and their project, task, and review capabilities', () => {
    const html = renderLanding()

    expect(html).toContain('id="channels"')
    expect(html).toContain('企业微信和钉钉')
    expect(html).toContain('群聊、私聊都能接入项目助手')
    expect(html).toContain('把讨论群绑定到任务')
    expect(html).toContain('在群里参与审核与确认')
    expect(html).toContain('图片和文件')
  })

  it('compares tool approaches without naming competing products or absolute claims', () => {
    const html = renderLanding()

    expect(html).toContain('不是工作流，是协作流')
    expect(html).toContain('交付产物、交接下一步')
    expect(html).toContain('直到任务完成')
    expect(html).toContain('模型 API 编排')
    expect(html).toContain('代码驱动编排')
    expect(html).toContain('托管任务助手')
    expect(html).not.toMatch(/Dify|Coze|CrewAI|LangGraph|Manus|Devin|黑盒|经验无法沉淀/)
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

  it('keeps the recorded walkthrough and three mechanism demos available after the product explanation', () => {
    const html = renderLanding()

    expect(html).toContain('class="guided-walkthrough"')
    expect(html).toContain('<video')
    expect(html).not.toContain('class="hero-preview"')
    expect(html.indexOf('class="guided-walkthrough"')).toBeGreaterThan(html.indexOf('id="intro-video"'))
    expect(DEMOS.map((demo) => demo.id)).toEqual(['canvas', 'stream', 'parallel'])
    expect(html.match(/id="mechanism-tab-\d"/g)).toHaveLength(3)
    expect(html).toContain('id="start"')
  })

  it('groups workflow explanations with demos, integrations together, and tutorials at the end', () => {
    const html = renderLanding()
    const introIndex = html.indexOf('id="intro-video"')
    const featuresIndex = html.indexOf('少一点来回交代，多一点过程掌控')
    const demosIndex = html.indexOf('看看步骤如何执行、结果如何查看')
    const workflowIndex = html.indexOf('先跑通开发任务，再扩展你的流程')
    const remoteShareIndex = html.indexOf('你的项目分享给我')
    const finalCtaIndex = html.indexOf('从一个能检查结果的小任务开始')

    expect(featuresIndex).toBeGreaterThan(-1)
    expect(html).not.toContain('像看视频一样')
    expect(demosIndex).toBeGreaterThan(introIndex)
    expect(featuresIndex).toBeGreaterThan(introIndex)
    expect(workflowIndex).toBeGreaterThan(introIndex)
    expect(html).toMatch(/<\/section>\s*<section class="section mechanism-gallery"/)
    const sections = [...html.matchAll(/<section\b[^>]*\bid="([^"]+)"/g)].map(match => match[1])
    expect(sections.indexOf('intro-video')).toBe(sections.indexOf('top') + 1)
    expect(sections.indexOf('features')).toBe(sections.indexOf('intro-video') + 1)
    expect(sections.indexOf('mechanisms')).toBe(sections.indexOf('features') + 1)
    expect(sections.indexOf('compare')).toBe(sections.indexOf('mechanisms') + 1)
    expect(sections.indexOf('channels')).toBe(sections.indexOf('workflow') + 1)
    expect(sections.indexOf('remote')).toBe(sections.indexOf('channels') + 1)
    expect(sections.indexOf('engines')).toBe(sections.indexOf('remote') + 1)
    expect(sections.indexOf('demos')).toBe(sections.indexOf('engines') + 1)
    expect(sections.indexOf('start')).toBe(sections.indexOf('demos') + 1)
    expect(demosIndex).toBeLessThan(remoteShareIndex)
    expect(html.indexOf('class="compare-table"')).toBeLessThan(html.indexOf('id="engines"'))
    expect(finalCtaIndex).toBeGreaterThan(remoteShareIndex)
  })

  it('distinguishes workflow ideas and interface animations from completed customer work', () => {
    const html = renderLanding()
    expect(html).toContain('以下是流程设计示例')
    expect(html).toContain('界面动画示意')
    expect(html).not.toContain('任意流程都能编排')
    expect(html).not.toContain('成稿发布一气呵成')
  })

  it('keeps the workflow examples focused on templates instead of raw JSON', () => {
    const html = renderLanding()

    expect(html).not.toContain('.workstep/steps.json')
    expect(html).not.toContain('&quot;requirements&quot;')
  })
})
