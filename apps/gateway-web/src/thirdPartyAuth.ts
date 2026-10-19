/** Website login transport: exact registered callbacks and per-login request IDs. */
export type ThirdPartyRequest = { callback: string; state: string; request_id: string }

export function validThirdPartyCallback(value: string): boolean {
 if(!value || value.length>2048 || !/^[\x21-\x7e]+$/.test(value) || value.includes('\\') || value.includes('#') || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value))return false
 try {
  const uri=new URL(value)
  const authority=value.match(/^https?:\/\/([^/?#]+)/i)?.[1]
  return !!authority && /^[A-Za-z0-9.\-:\[\]]+(?::[0-9]+)?$/.test(authority)
   && ['http:','https:'].includes(uri.protocol) && !!uri.hostname && !uri.username && !uri.password && uri.port!=='0'
   && ![...uri.searchParams.keys()].some(key=>['code','state','request_id'].includes(key.toLowerCase()))
 }catch{return false}
}

export function thirdPartyRequest(params: URLSearchParams): ThirdPartyRequest | null {
 const keys=['callback','state','request_id']
 if([...params.keys()].some(key=>!keys.includes(key)) || keys.some(key=>params.getAll(key).length!==1))return null
 const request={callback:params.get('callback')!,state:params.get('state')!,request_id:params.get('request_id')!}
 return validThirdPartyCallback(request.callback) && /^[A-Za-z0-9._~-]{1,256}$/.test(request.state)
  && /^[A-Za-z0-9_-]{32,128}$/.test(request.request_id)?request:null
}

export function validIssuedCallback(value: string, request: ThirdPartyRequest): boolean {
 const prefix=request.callback+(request.callback.includes('?')?'&':'?')
 if(!value.startsWith(prefix))return false
 const issued=new URLSearchParams(value.slice(prefix.length))
 return [...issued.keys()].length===2 && issued.getAll('code').length===1 && issued.getAll('state').length===1
  && /^[A-Za-z0-9_-]+$/.test(issued.get('code')??'') && issued.get('state')===request.state
}

export async function thirdPartyError(response: Response, fallback: string): Promise<Error> {
 const body=await response.json().catch(()=>null)
 return Error(body?.error?.message || fallback)
}
