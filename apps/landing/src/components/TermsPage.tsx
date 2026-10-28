import { SupportLink } from './CommerceInfo'

export function TermsPage() {
  return <main className="legal-page container">
    <a href="#top">返回首页 / Back to WorkStep</a>
    <h1>使用条款 / Terms of Use</h1>
    <p>更新日期 / Updated: 2026-10-28 · 简体中文 / English</p>
    <section lang="zh-CN">
      <h2>产品、费用与许可</h2>
      <p>WorkStep 是本地优先的 AI 研发工作台。当前桌面应用免费开源，无 WorkStep 订阅费、激活费或付费购买要求。软件使用、修改与分发适用 Apache License 2.0；本说明不限制该许可授予的权利。</p>
      <h2>第三方服务与使用责任</h2>
      <p>你需要自行配置执行引擎和模型供应商账号，并遵守相关服务条款、许可及费用规则。WorkStep 不附赠模型额度或第三方订阅。请仅操作你有权访问的项目，遵守适用法律，并在运行任务前检查工具权限、备份重要数据；生成代码与产物应经过人工核对。</p>
      <h2>早期体验与支持</h2>
      <p>当前版本为早期体验版，桌面安装包尚未签名。软件按 Apache License 2.0 规定以“现状”提供，不承诺生成结果、持续可用性、特定用途适用性或支持响应时限；适用法律要求保留的权利不受影响。</p>
      <h2>交付、订单与联系</h2>
      <p>官方安装包通过 GitHub Releases 提供，使用指南在官网文档中公开。当前 Creem 商品免费，仅提供下载与入门说明，无付费 WorkStep 订阅，因此没有 WorkStep 订阅扣款或退款。第三方服务的费用、取消和退款由对应服务商处理。如遇意外扣款或交付问题，请联系支持。</p>
    </section>
    <section lang="en">
      <h2>Product, pricing and license</h2>
      <p>WorkStep is a local-first AI development workspace. The current desktop app is free and open source. No paid WorkStep subscription, activation fee or purchase is required. Use, modification and distribution of the software are governed by Apache License 2.0; this notice does not limit rights granted by that license.</p>
      <h2>Third-party services and your responsibilities</h2>
      <p>You configure your own execution engines and model-provider accounts and follow their terms, licenses and pricing. Model credits and third-party subscriptions are not included. Access only projects you are authorized to use, follow applicable laws, review tool permissions and back up important data before running tasks. Check generated code and outputs before use.</p>
      <h2>Early access and support</h2>
      <p>This is early-access software and desktop packages are currently unsigned. The software is provided on an “AS IS” basis under Apache License 2.0, without promises of generated results, continuous availability, fitness for a particular purpose or support response times. Rights that must be preserved under applicable law are unaffected.</p>
      <h2>Delivery, orders and contact</h2>
      <p>Official installers are distributed through GitHub Releases, with public setup instructions on this website. The current Creem product is free and supplies download and setup instructions. There are no paid WorkStep subscriptions, charges or refunds. Third-party charges, cancellations and refunds are handled by the relevant provider. Contact support about unexpected charges or delivery problems.</p>
    </section>
    <p><a href="https://github.com/xzregg/workstep/blob/main/LICENSE" target="_blank" rel="noreferrer">Apache License 2.0</a> · <a href="#privacy">隐私 / Privacy</a></p>
    <p>支持 / Support: <SupportLink /></p>
  </main>
}
