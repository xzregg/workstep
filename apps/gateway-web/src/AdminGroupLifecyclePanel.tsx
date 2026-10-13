import { AdminRowMenu } from './AdminRowMenu'
import { useState } from 'react'
import { AdminUserGroupTree } from './AdminUserGroupTree'
import { AdminBulkActionDialog } from './AdminBulkActionDialog'
import type { BulkAction } from './AdminBulkActionDialog'

export function AdminGroupLifecyclePanel({csrf,selected,revision,onSelect,onChanged}: {
 csrf:string; selected:string; revision:number; onSelect:(id:string)=>void; onChanged:()=>void
}) {
 const [deleted,setDeleted]=useState(false)
 const [checked,setChecked]=useState<string[]>([])
 const [action,setAction]=useState<BulkAction|null>(null)
 function request(ids:string[], purge = false) {
  const verb=purge?'彻底删除':deleted?'恢复':'删除'
  setAction({title:`${verb}用户组`,label:`确认${verb}`,password:true,url:'/api/groups/bulk',body:{group_ids:ids,action:purge?'purge':deleted?'restore':'delete'},
   message:purge?`彻底删除所选 ${ids.length} 个用户组及其成员关联、项目关联和权限分配？无法恢复，组内用户和项目不会被删除。企业同步不会重新创建这些用户组。`:deleted?`恢复所选 ${ids.length} 个用户组及其成员、项目关联和权限？`:`删除所选 ${ids.length} 个用户组？组内用户不会被删除，组权限和 Skill 分配将失效。可在“用户组回收站”中恢复。仅删除已勾选的组，选择上级时包含全部下级组织。`})
 }
 return <>
  <div className="gateway-group-view-toolbar" role="group" aria-label="用户组视图">
   <strong>{deleted?'用户组回收站':'用户组'}</strong>
   <button type="button" aria-pressed={deleted} onClick={()=>{setDeleted(value=>!value);setChecked([]);onSelect('')}}>{deleted?'返回用户组':'用户组回收站'}</button>
  </div>
  <div className="gateway-tree-tools gateway-group-action-bar" role="group" aria-label="用户组操作">
   <span>已选 {checked.length} 个组</span>
   <button type="button" aria-label="取消选择" disabled={!checked.length} onClick={()=>setChecked([])}>清空</button>
   <button type="button" aria-label={deleted?'恢复所选用户组':'删除所选用户组'} className={deleted?'':'gateway-admin-danger'}
    disabled={!csrf || !checked.length || checked.length>100} onClick={()=>request(checked)}>{deleted?'恢复所选':'删除所选'}</button>
   <AdminRowMenu label="用户组更多操作" triggerLabel="更多">
    {deleted ? <button type="button" className="gateway-admin-danger" disabled={!csrf || !checked.length || checked.length>100}
      onClick={()=>request(checked,true)}>彻底删除所选用户组</button> : <button type="button" className="gateway-admin-danger" disabled={!csrf || !selected}
      onClick={()=>request([selected])}>删除当前用户组</button>}
   </AdminRowMenu>
  </div>
  {deleted && <p>勾选用户组后可恢复或彻底删除。恢复保留关联和权限，彻底删除不可撤销。</p>}
  <p className="gateway-tree-selection-hint">勾选上级会同时选择全部下级（含搜索隐藏的组）；点击组名查看成员。</p>
  {checked.length > 100 && <p role="status">每批最多操作 100 个用户组，请减少勾选后再操作。</p>}
  <AdminUserGroupTree key={deleted?'deleted':'active'} selected={selected} revision={revision} allUsers={false}
   endpoint={deleted?'/api/groups/deleted':'/api/admin/user-groups/tree'} checked={checked} onCheck={setChecked} onSelect={deleted?()=>{}:onSelect}/>
  {action && <AdminBulkActionDialog action={action} csrf={csrf} onClose={()=>setAction(null)} onDone={()=>{setAction(null);setChecked([]);onSelect('');onChanged()}}/>}
 </>
}
