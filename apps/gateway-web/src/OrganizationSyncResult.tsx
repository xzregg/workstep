export type SyncResult = {
 departments?: number; people?: number; departments_added?: number; people_added?: number;
 people_updated?: number; people_transferred?: number; people_departed?: number;
 people_unverified?: number; people_restoration_pending?: number; departments_updated?: number;
 departments_moved?: number; departments_deleted?: number; departments_deleted_skipped?: number;
 people_deleted_skipped?: number;
 details?: {kind: string; name: string; before?: {name?: string; parent?: string; departments?: string[]; active?: boolean}; after?: {name?: string; parent?: string; departments?: string[]; active?: boolean}}[]
}
export function OrganizationSyncResult({result, departmentNames = new Map()}: {result?: SyncResult; departmentNames?: Map<string,string>}) {
 function fields(value: NonNullable<SyncResult['details']>[number]['before']) {
  if (!value) return '无'
  return [value.name, value.departments?.map(id=>departmentNames.get(id) ?? id).join('、'), value.parent ? `上级：${departmentNames.get(value.parent) ?? value.parent}` : '', value.active === undefined ? '' : value.active ? '企业侧正常' : '企业侧已停用'].filter(Boolean).join(' · ')
 }
 return <><p>本次新增：{result?.departments_added ?? 0} 个组织、{result?.people_added ?? 0} 位用户。跳过本地已删除：{result?.departments_deleted_skipped ?? 0} 个组织、{result?.people_deleted_skipped ?? 0} 位用户；请在回收站恢复后启用。</p>
  <p>用户改名 {result?.people_updated ?? 0} · 调部门 {result?.people_transferred ?? 0} · 离职／停用 {result?.people_departed ?? 0} · 待核实 {result?.people_unverified ?? 0} · 待管理员恢复 {result?.people_restoration_pending ?? 0}</p>
  <p>组织改名 {result?.departments_updated ?? 0} · 移动 {result?.departments_moved ?? 0} · 删除 {result?.departments_deleted ?? 0}</p>
  {!!result?.details?.length && <details><summary>查看变更明细</summary><ul>{result.details.map((item,index)=><li key={index}>{item.name} · {item.kind === 'unverified' ? '待核实，保留访问状态' : item.kind === 'departed' ? '已离职／停用' : item.kind === 'department_deleted' ? '企业侧已删除组织' : '资料变更'}{item.before != null && <p>{fields(item.before)} → {fields(item.after)}</p>}</li>)}</ul></details>}
 </>
}
