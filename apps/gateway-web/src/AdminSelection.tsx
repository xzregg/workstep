import { useEffect, useRef, useState } from 'react'

export function useAdminSelection(ids: string[], resetKey?: unknown) {
 const [selected, setSelected] = useState<string[]>([])
 const key = ids.join(',')
 useEffect(() => setSelected([]), [key, resetKey])
 const toggle = (id: string, checked: boolean) => setSelected(previous => checked
  ? [...new Set([...previous, id])] : previous.filter(value => value !== id))
 return {selected, setSelected, toggle}
}

export function AdminSelectAll({ids, selected, onChange, disabled = false}: {
 ids: string[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean
}) {
 const input = useRef<HTMLInputElement>(null)
 const count = ids.filter(id => selected.includes(id)).length
 useEffect(() => {if (input.current) input.current.indeterminate = count > 0 && count < ids.length}, [count, ids.length])
 return <input ref={input} className="gateway-table-checkbox" type="checkbox" aria-label="全选当前表格"
  disabled={disabled || !ids.length} checked={!!ids.length && count === ids.length}
  onChange={event => onChange(event.target.checked ? ids : [])}/>
}

export function loginUsername(user: {username: string; login_username?: string | null}): string | null {
 if (user.login_username !== undefined) return user.login_username
 return user.username.startsWith('ext_') ? null : user.username
}

export function AdminPersonName({user}: {user: {display_name: string; username: string; login_username?: string | null}}) {
 const login = loginUsername(user)
 return <div className="gateway-person-name"><strong>{user.display_name}</strong>
  <small>{login ? `登录用户名：${login}` : '组织账号 · 扫码登录'}</small></div>
}
