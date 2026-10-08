export function EnterpriseLoginIcon({provider}: {provider:'dingtalk'|'wecom'}) {
 return <svg className={`gateway-identity-icon gateway-identity-icon--${provider}`} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  {provider==='dingtalk'?<path fill="currentColor" d="M5 5l22 7-9 5 5 2-12 9 3-9-7-2 6-3-8-4z"/>
   :<><path fill="currentColor" d="M3 7h16a7 7 0 017 7v2a7 7 0 01-7 7h-7l-6 4 1-5a7 7 0 01-4-6z"/><path fill="white" d="M13 10h12a5 5 0 015 5v2a5 5 0 01-5 5h-5l-4 3v-4a5 5 0 01-3-4z"/><circle fill="currentColor" cx="20" cy="16" r="1.2"/><circle fill="currentColor" cx="25" cy="16" r="1.2"/></>}
 </svg>
}
