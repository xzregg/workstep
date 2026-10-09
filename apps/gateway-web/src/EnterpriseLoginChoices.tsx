import { EnterpriseLoginIcon } from './EnterpriseLoginIcon'
export type EnterpriseSource={id:string;provider:'dingtalk'|'wecom'}
export function EnterpriseLoginChoices({sources,passwordEnabled,busy=false,onSelect}: {
 sources:EnterpriseSource[];passwordEnabled:boolean;busy?:boolean;onSelect:(id:string)=>void
}) {
 if(!sources.length)return null
 return <div className={`gateway-auth-external${passwordEnabled?'':' gateway-auth-external--only'}`}>
  <p>{passwordEnabled?'或使用企业身份登录':'使用企业身份扫码登录'}</p>
  {sources.map(source=><button className="gateway-enterprise-login" key={source.id} type="button" disabled={busy}
   aria-label={`${source.provider==='dingtalk'?'钉钉':'企业微信'}扫码登录`} onClick={()=>onSelect(source.id)}>
   <EnterpriseLoginIcon provider={source.provider}/><span>{source.provider==='dingtalk'?'钉钉':'企业微信'}</span>
  </button>)}
 </div>
}
