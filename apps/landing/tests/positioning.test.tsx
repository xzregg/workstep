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
  it('explains a concrete development task before introducing engine choices', () => {
    const html = renderLanding()

    expect(html).toContain('例如：给项目加一个搜索功能')
    expect(html).toContain('代码改动与实现说明')
    expect(html).toContain('测试结果与待处理问题')
    expect(html.indexOf('例如：给项目加一个搜索功能')).toBeLessThan(html.indexOf('class="engines-strip"'))
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

    expect(html).toContain('不同工作流，各有侧重')
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

  it('keeps the hero preview and all three interactive demos', () => {
    const html = renderLanding()

    expect(html).toContain('class="hero-preview"')
    expect(DEMOS.map((demo) => demo.id)).toEqual(['canvas', 'stream', 'parallel'])
    expect(html.match(/class="demo-card"/g)).toHaveLength(3)
  })

  it('places the example and demos before advanced capabilities and collaboration', () => {
    const html = renderLanding()
    const exampleIndex = html.indexOf('例如：给项目加一个搜索功能')
    const featuresIndex = html.indexOf('少一点来回交代，多一点过程掌控')
    const demosIndex = html.indexOf('看看步骤如何执行、结果如何查看')
    const workflowIndex = html.indexOf('先跑通开发任务，再扩展你的流程')
    const remoteShareIndex = html.indexOf('你的项目分享给我')
    const finalCtaIndex = html.indexOf('从一个能检查结果的小任务开始')

    expect(featuresIndex).toBeGreaterThan(-1)
    expect(html).not.toContain('像看视频一样')
    expect(demosIndex).toBeGreaterThan(exampleIndex)
    expect(featuresIndex).toBeGreaterThan(demosIndex)
    expect(workflowIndex).toBeGreaterThan(featuresIndex)
    expect(remoteShareIndex).toBeGreaterThan(workflowIndex)
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
