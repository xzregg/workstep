export type Project = {id:string; name:string; device_id:string; device_name:string;
 device_online:boolean; access_level:'read'|'edit'; grant_sources:string[]}

export function ProjectCard({project,opening,blocked=false,onOpen}: {
 project:Project; opening:boolean; blocked?:boolean; onOpen:()=>void
}) {
 return <li><div><strong>{project.name}</strong>
  <p>宿主电脑：{project.device_name} · {project.device_online?'在线':'离线'}</p>
  <p>{project.access_level==='edit'?'可编辑':'只读'} · {project.grant_sources.join('、')}</p>
 </div><button type="button" disabled={!project.device_online || blocked || opening} onClick={onOpen}>{opening?<><span className="gateway-spinner"/> 正在打开…</>:'打开项目'}</button></li>
}
