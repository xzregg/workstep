import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ProjectCard } from './ProjectCard'
import type { Project } from './ProjectCard'

export type WorkspaceDevice = {id:string; name:string; online:boolean; project_only?:boolean}
export function MyWorkstepWorkspace({devices,projects,opening,onOpenDevice,onOpenProject}: {
 devices:WorkspaceDevice[]; projects:Project[]; opening:string|null
 onOpenDevice:(id:string)=>void; onOpenProject:(id:string)=>void
}) {
 const [selected,setSelected]=useState('')
 const [search,setSearch]=useState('')
 const device=devices.find(item=>item.id===selected)
 const visible=projects.filter(project=>(!selected || project.device_id===selected) && project.name.toLowerCase().includes(search.trim().toLowerCase()))
 return <div className="gateway-workstep-window">
  <aside className="gateway-workstep-sidebar" aria-label="WorkStep 设备">
   <h3>工作空间</h3>
   <button type="button" className={!selected?'gateway-workspace-selected':''} aria-pressed={!selected} onClick={()=>setSelected('')}>全部项目<span>{projects.length}</span></button>
   <h3>我的设备</h3>
   {devices.map(item=><button type="button" key={item.id} className={selected===item.id?'gateway-workspace-selected':''} aria-pressed={selected===item.id} aria-label={item.name} disabled={opening!==null} onClick={()=>{setSelected(item.id); if(item.online && !item.project_only)onOpenDevice(item.id)}}>
    <span className="gateway-workspace-device-name" title={item.name}>{item.name}</span><small className={item.online?'gateway-online':'gateway-offline'}>{item.online?'在线':'离线'}</small>
   </button>)}
   <Link to="/devices/empty">安装 WorkStep</Link>
  </aside>
  <section className="gateway-workstep-content" aria-label="WorkStep 项目">
   <div className="gateway-workspace-toolbar"><div><h3>{device?.name ?? '全部项目'}</h3><p>{device?(device.project_only?'仅可访问已授权项目。':device.online?'正在进入设备的 WorkStep 工作台…':'设备离线，等待上线后可进入工作台。'):'选择在线设备，直接进入你的 WorkStep。'}</p></div>
    {opening?.startsWith('device:') && <p role="status"><span className="gateway-spinner"/>正在连接设备…</p>}
   </div>
   <label className="gateway-workspace-search">搜索项目<input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="输入项目名称"/></label>
   {!visible.length && <div className="gateway-workspace-empty"><h3>{search?'未找到匹配的项目':'暂无远程项目'}</h3><p>{search?'换个项目名称试试。':device?'可直接打开 WorkStep，在设备中查看和管理项目。':'选择左侧设备，打开 WorkStep 查看任务和工作流。'}</p></div>}
   <ul className="gateway-device-list gateway-workspace-projects">{visible.map(project=><ProjectCard key={project.id} project={project} opening={opening==='project:'+project.id} blocked={opening!==null} onOpen={()=>onOpenProject(project.id)}/>)}</ul>
  </section>
 </div>
}
