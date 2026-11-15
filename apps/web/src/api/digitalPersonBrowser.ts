import {request} from './transport'
export interface DigitalBrowserStatus {
  engine_compatible?:boolean; ready:boolean; driver:boolean; browser:boolean; node:boolean; npm:boolean; builtin:boolean
  version:string; status:string; enabled:boolean; installing:boolean; error:string
}
export const digitalBrowserApi={
  status:()=>request<DigitalBrowserStatus>('/digital-person/browser'),
  install:()=>request<DigitalBrowserStatus>('/digital-person/browser/install',{method:'POST'}),
  enable:(enabled:boolean)=>request<DigitalBrowserStatus>('/digital-person/browser',{method:'PUT',body:JSON.stringify({enabled})}),
}
