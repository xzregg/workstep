import { Fragment, useState } from 'react'
import type { ProjectPermission, ProjectPermissionSet } from './ProjectPermissionDialog'
import { scopeNames, type PermissionAssignment } from './PermissionDialogs'

export function PermissionSubjectTable({ assignments, name, projectCatalog = [], projectSets = [], canEdit, canRevoke, onEdit, onRevoke }: {
  assignments: PermissionAssignment[]; name: (permission: string) => string
  projectCatalog?: ProjectPermission[]; projectSets?: ProjectPermissionSet[]
  canEdit: boolean; canRevoke: boolean
  onEdit: (row: PermissionAssignment) => void; onRevoke: (row: PermissionAssignment) => void
}) {
  const policyTitle = (row: PermissionAssignment) => {
    const policy = row.ui_permissions
    if (!policy) return name(row.permission)
    const preset = !policy.deny.length && projectSets.find(set => set.permissions.length === policy.allow.length && set.permissions.every(key => policy.allow.includes(key)))
    return `${preset ? preset.name : '自定义项目权限'}（允许 ${policy.allow.length} 项 · 禁止 ${policy.deny.length} 项）`
  }
  const permissionName = (key: string) => projectCatalog.find(item => item.id === key)?.name ?? key
  const [expanded, setExpanded] = useState<string[]>([])
  const groups = new Map<string, PermissionAssignment[]>()
  for (const row of assignments) {
    const key = `${row.subject_type}:${row.subject_id}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return <div className="gateway-admin-table-scroll" tabIndex={0} role="region" aria-label="授权对象汇总，可左右滚动">
    <table className="gateway-admin-table gateway-permission-table"><thead><tr>
      <th scope="col">授权对象</th><th scope="col">权限汇总</th><th scope="col">作用范围</th><th scope="col">规则汇总</th><th scope="col">操作</th>
    </tr></thead><tbody>{[...groups].map(([key, rows]) => {
      const subject = rows[0]
      const open = expanded.includes(key)
      const allowed = rows.filter(row => row.effect === 'allow').length
      const policies = rows.filter(row => row.ui_permissions)
      const fineAllow = policies.reduce((sum, row) => sum + row.ui_permissions!.allow.length, 0)
      const fineDeny = policies.reduce((sum, row) => sum + row.ui_permissions!.deny.length, 0)
      return <Fragment key={key}><tr>
        <td><strong>{subject.subject_name}</strong><span className="gateway-permission-detail">{subject.subject_type === 'user' ? '用户' : '用户组'}</span></td>
        <td>{[...new Set(rows.map(policyTitle))].join('、')}</td>
        <td>{[...new Set(rows.map(row => `${scopeNames[row.scope_type]} · ${row.scope_name}`))].join('；')}</td>
        <td>{policies.length ? <><span>允许 {fineAllow} 项 · 禁止 {fineDeny} 项</span>
          <span className="gateway-permission-detail">项目权限按项目累计；基础授权：允许 {allowed} 条 · 禁止 {rows.length - allowed} 条</span></>
          : <>允许 {allowed} 项 · 禁止 {rows.length - allowed} 项</>}</td>
        <td><button type="button" aria-expanded={open} onClick={() => setExpanded(current => open
          ? current.filter(value => value !== key) : [...current, key])}>{open ? '收起规则' : '查看规则'}</button></td>
      </tr>{open && <tr><td colSpan={5}><ul className="gateway-permission-subject-rules">{rows.map(row => <li key={row.id}>
        <div><strong>{policyTitle(row)}</strong><span className="gateway-permission-detail">{scopeNames[row.scope_type]} · {row.scope_name}</span>
          {row.ui_permissions && <ul className="gateway-permission-policy-details" aria-label={`${row.scope_name}的项目权限明细`}>
            {row.ui_permissions.allow.map(key => <li key={`allow:${key}`}>{permissionName(key)}</li>)}
            {row.ui_permissions.deny.map(key => <li className="gateway-permission-effect--deny" key={`deny:${key}`}>禁止 · {permissionName(key)}</li>)}
          </ul>}</div>
        <span className={`gateway-permission-effect gateway-permission-effect--${row.effect}`}>{row.effect === 'allow' ? '允许' : '禁止'}</span>
        <div className="gateway-device-actions"><button type="button" disabled={!canEdit} onClick={() => onEdit(row)}>调整</button>
          <button type="button" disabled={!canRevoke} onClick={() => onRevoke(row)}>撤销</button></div>
      </li>)}</ul></td></tr>}</Fragment>
    })}</tbody></table>
  </div>
}
