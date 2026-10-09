import { Fragment, useState } from 'react'
import { scopeNames, type PermissionAssignment } from './PermissionDialogs'

export function PermissionSubjectTable({ assignments, name, canEdit, canRevoke, onEdit, onRevoke }: {
  assignments: PermissionAssignment[]; name: (permission: string) => string
  canEdit: boolean; canRevoke: boolean
  onEdit: (row: PermissionAssignment) => void; onRevoke: (row: PermissionAssignment) => void
}) {
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
      return <Fragment key={key}><tr>
        <td><strong>{subject.subject_name}</strong><span className="gateway-permission-detail">{subject.subject_type === 'user' ? '用户' : '用户组'}</span></td>
        <td>{[...new Set(rows.map(row => name(row.permission)))].join('、')}</td>
        <td>{[...new Set(rows.map(row => `${scopeNames[row.scope_type]} · ${row.scope_name}`))].join('；')}</td>
        <td>允许 {allowed} 项 · 禁止 {rows.length - allowed} 项</td>
        <td><button type="button" aria-expanded={open} onClick={() => setExpanded(current => open
          ? current.filter(value => value !== key) : [...current, key])}>{open ? '收起规则' : '查看规则'}</button></td>
      </tr>{open && <tr><td colSpan={5}><ul className="gateway-permission-subject-rules">{rows.map(row => <li key={row.id}>
        <div><strong>{name(row.permission)}</strong><span className="gateway-permission-detail">{scopeNames[row.scope_type]} · {row.scope_name}</span></div>
        <span className={`gateway-permission-effect gateway-permission-effect--${row.effect}`}>{row.effect === 'allow' ? '允许' : '禁止'}</span>
        <div className="gateway-device-actions"><button type="button" disabled={!canEdit} onClick={() => onEdit(row)}>调整</button>
          <button type="button" disabled={!canRevoke} onClick={() => onRevoke(row)}>撤销</button></div>
      </li>)}</ul></td></tr>}</Fragment>
    })}</tbody></table>
  </div>
}
