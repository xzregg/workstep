import * as React from 'react'
export type TabDevice = {id:string;name:string;online:boolean}
export function DeviceTabs({devices,currentDeviceId,onSelect,onRefresh,disabled=false,disableOffline=false,showRefresh=true}:{
 devices:TabDevice[];currentDeviceId:string;onSelect:(id:string)=>void;onRefresh:()=>void;disabled?:boolean;disableOffline?:boolean;showRefresh?:boolean
}): React.JSX.Element {
 return <div className="gateway-instance-toolbar"><div className="gateway-instance-tabs" role="tablist" aria-label="切换 WorkStep 设备实例">
  {devices.map(item=><button key={item.id} type="button" role="tab" aria-selected={item.id===currentDeviceId}
   disabled={disabled || (disableOffline && !item.online)} onClick={()=>onSelect(item.id)}>
   <span className="gateway-instance-name" title={item.name || item.id}>{item.name || item.id}</span>
   <span className={item.online?'gateway-online':'gateway-offline'}>{item.online?'在线':'离线'}</span>
  </button>)}
 </div>{showRefresh && <button type="button" className="gateway-tab-refresh" aria-label="刷新设备列表" disabled={disabled} onClick={onRefresh}>↻</button>}</div>
}
