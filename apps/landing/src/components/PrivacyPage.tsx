import { useI18n } from '../i18n'
import { SupportLink } from './CommerceInfo'

export function PrivacyPage() {
  const { t } = useI18n()
  return <main className="privacy-page container">
    <a href="#top">{t('privacy.home')}</a>
    <h1>{t('privacy.title')}</h1>
    <p>{t('privacy.localData')}</p>
    <p>{t('privacy.externalServices')}</p>
    <section className="legal-supplement">
      <h2>支持与订单 / Support and orders</h2>
      <p lang="zh-CN">联系支持时，你发送的邮箱、问题描述和自愿提供的诊断信息将用于处理咨询。请勿发送密钥、私人项目或支付卡信息。我们仅在处理问题、履行法定义务或处理争议所需的范围内保留相关信息；可通过支持邮箱提出查询、更正或删除请求。</p>
      <p lang="en">When you contact support, your email, support correspondence and any diagnostic information you choose to provide are used to handle your request. Do not send credentials, private projects or payment card information. We retain this information only as needed to handle requests, meet legal obligations or resolve disputes. Contact support to request access, correction or deletion.</p>
      <p lang="zh-CN">如果你通过 Creem 领取当前免费商品，Creem 会依据其隐私政策处理结账邮箱和订单信息。我们可能接收用于交付与支持的订单和联系信息。当前商品不收费；第三方模型服务的数据处理适用各供应商规则。</p>
      <p lang="en">If you obtain the current free product through Creem, Creem processes checkout email and order information under its privacy policy. We may receive order and contact information needed for delivery and support. The current product has no charge. External model services process data under their own policies.</p>
      <p><a href="https://www.creem.io/privacy" target="_blank" rel="noreferrer">Creem Privacy Policy</a> · <a href="#terms">使用条款 / Terms of Use</a></p>
      <p>支持 / Support: <SupportLink /></p>
    </section>
  </main>
}
