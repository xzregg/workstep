import { EnterpriseLoginIcon } from './EnterpriseLoginIcon'
import { enterpriseProviderName, type EnterpriseProvider } from './enterpriseProviders'
export type EnterpriseSource={id:string;provider:EnterpriseProvider}
export function EnterpriseLoginChoices({sources,passwordEnabled,busy=false,onSelect}: {
 sources:EnterpriseSource[];passwordEnabled:boolean;busy?:boolean;onSelect:(id:string)=>void
}) {
 if(!sources.length)return null
 return <div className={`gateway-auth-external${passwordEnabled?'':' gateway-auth-external--only'}`}>
  <p>{passwordEnabled?'或使用企业身份登录':'使用企业身份扫码登录'}</p>
  {sources.map(source=><button className="gateway-enterprise-login" key={source.id} type="button" disabled={busy}
   aria-label={`${enterpriseProviderName(source.provider)}扫码登录`} onClick={()=>onSelect(source.id)}>
   <EnterpriseLoginIcon provider={source.provider}/><span>{enterpriseProviderName(source.provider)}</span>
  </button>)}
 </div>
}
