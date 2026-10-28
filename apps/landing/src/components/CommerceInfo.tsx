import { RELEASES_URL } from '../config/downloads'

export const SUPPORT_EMAIL = 'xzregg@gmail.com'

export function SupportLink() {
  return <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
}

export function CommerceInfo() {
  return <section id="pricing" className="commerce-info container" aria-labelledby="pricing-title">
    <div>
      <h2 id="pricing-title">免费开源 / Free and open source</h2>
      <p className="commerce-price">¥0 / $0</p>
      <p>WorkStep 桌面应用采用 Apache License 2.0，无 WorkStep 订阅费或激活费。第三方模型、引擎和服务费用另计。</p>
      <p lang="en">The WorkStep desktop app is licensed under Apache License 2.0, with no WorkStep subscription or activation fee. Third-party model services are billed separately.</p>
      <a className="btn btn-primary" href={RELEASES_URL}>免费下载 / Download free</a>
    </div>
    <div className="commerce-support">
      <h3>联系支持 / Customer support</h3>
      <p><SupportLink /></p>
      <p>安装、使用或订单相关问题，请注明系统与应用版本；请勿发送密钥、私人项目或支付卡信息。</p>
      <p lang="en">For installation, usage or order questions, include your OS and app version. Do not send credentials, private projects or payment card information.</p>
      <p><a href="#terms">使用条款 / Terms of Use</a> · <a href="#privacy">隐私 / Privacy</a></p>
    </div>
  </section>
}
