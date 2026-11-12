import type { DecisionProxy } from '../api/decisionModels'
import CopyablePath from './CopyablePath'
import { useI18n } from '../i18n'

interface Props {
  proxy: DecisionProxy
  enabled: boolean
  accessKey: string
  disabled: boolean
  enableDisabled?: boolean
  onChange: (enabled: boolean, key: string) => void
}
export default function DecisionProxySettings({ proxy, enabled, accessKey, disabled, enableDisabled = false, onChange }: Props) {
  const { t } = useI18n()
  const base = proxy.remote_url || proxy.lan_url || proxy.local_url
  const sample = `curl '${base}/systemone' \\
  -H 'Authorization: Bearer <WORKSTEP_ACCESS_KEY>' \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"${proxy.model ?? 'laya-multilingual'}","state":"The service is ready.","questions":{"ready":{"type":"noul","instructions":"Is the service ready?"}}}'`
  return <section className="decision-block decision-proxy">
    <div className="decision-block-head"><h2>{t('decisionModels.proxyTitle')}</h2><span className="decision-badge">{t(proxy.enabled && proxy.access_key_set ? 'decisionModels.proxyOn' : 'decisionModels.proxyOff')}</span></div>
    <div className="decision-form">
      <label className="decision-proxy-switch"><input id="decision-proxy-enabled" type="checkbox" checked={enabled} disabled={disabled || (enableDisabled && !enabled)} onChange={e => onChange(e.target.checked, accessKey)} />{t('decisionModels.proxyEnable')}</label>
      <p>{t('decisionModels.proxyHint')}</p>
      {proxy.access_key_set ? <p>{t('decisionModels.proxyReuseKey')}</p> : <label htmlFor="decision-access-key">{t('decisionModels.proxyKey')}<input id="decision-access-key" type="password" autoComplete="new-password" value={accessKey} disabled={disabled} onChange={e => onChange(enabled, e.target.value)} /><small>{t('decisionModels.proxyKeyHint')}</small></label>}
      <dl className="decision-proxy-addresses">
        <div><dt>{t('decisionModels.proxyLocal')}</dt><dd><CopyablePath path={proxy.local_url} /></dd></div>
        {proxy.lan_url && <div><dt>{t('decisionModels.proxyLan')}</dt><dd><CopyablePath path={proxy.lan_url} /></dd></div>}
        {proxy.remote_url && <div><dt>{t('decisionModels.proxyRemote')}</dt><dd><CopyablePath path={proxy.remote_url} /></dd></div>}
      </dl>
      <p>{t('decisionModels.proxyNetworkHint')}</p>
      <p>{t('decisionModels.proxyLimits')}</p>
      <details><summary>{t('decisionModels.proxyExample')}</summary><pre>{sample}</pre></details>
    </div>
  </section>
}
