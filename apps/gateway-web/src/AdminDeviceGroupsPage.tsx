import { useEffect, useState } from 'react'

type Group = { id: string; name: string; device_ids: string[] }
type Choice = { id: string; name?: string; display_name?: string }

export function AdminDeviceGroupsPage() {
  const [csrf, setCsrf] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const [devices, setDevices] = useState<Choice[]>([])
  const [departments, setDepartments] = useState<Choice[]>([])
  const [groupId, setGroupId] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void Promise.all(['/api/auth/session', '/api/admin/device-groups?page_size=100',
      '/api/admin/devices?page_size=100', '/api/admin/departments?page_size=100'].map(async path => {
      const response = await fetch(path, { credentials: 'same-origin', signal: controller.signal })
      if (!response.ok) throw new Error('设备管理范围加载失败，请重试。')
      return response.json()
    })).then(([session, groupList, deviceList, departmentList]) => {
      if (!controller.signal.aborted) { setCsrf(session.csrf_token); setGroups(groupList.groups);
        setDevices(deviceList.devices); setDepartments(departmentList.departments) }
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '加载失败。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  async function mutate(path: string, method: string, body?: unknown) {
    if (busy || !csrf || !password) return
    setBusy(true); setError(''); setNotice('')
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
    try {
      const step = await fetch('/api/auth/step-up', { method: 'POST', credentials: 'same-origin',
        headers, body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(path, { method, credentials: 'same-origin', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      if (!response.ok) throw new Error('管理范围保存失败，请重试。')
      setNotice('管理范围已保存。'); setPassword(''); setName(''); setRevision(value => value + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败。') }
    finally { setBusy(false) }
  }
  const disabled = busy || loading || !csrf || !password
  return <section className="gateway-admin-page">
    <h2>设备组与部门归属</h2>
    <p>管理范围决定管理员可操作的设备。设备及项目内容访问须单独授权。</p>
    {loading && <p role="status"><span className="gateway-spinner" aria-hidden="true" />正在加载管理范围…</p>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="gateway-auth-form">
      <label htmlFor="device-group-name">新设备组名称</label>
      <input id="device-group-name" value={name} onChange={event => setName(event.target.value)} disabled={busy} />
      <button type="button" disabled={disabled || !name.trim()}
        onClick={() => void mutate('/api/admin/device-groups', 'POST', { name: name.trim() })}>创建设备组</button>
      <label htmlFor="device-group-choice">设备组</label>
      <select id="device-group-choice" value={groupId} onChange={event => setGroupId(event.target.value)} disabled={busy}>
        <option value="">选择设备组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select>
      {groupId && <p>组内设备：{groups.find(group => group.id === groupId)?.device_ids.map(id =>
        devices.find(device => device.id === id)?.name ?? id).join('、') || '暂无'}</p>}
      <label htmlFor="managed-device-choice">设备</label>
      <select id="managed-device-choice" value={deviceId} onChange={event => setDeviceId(event.target.value)} disabled={busy}>
        <option value="">选择设备</option>{devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
      </select>
      <div className="gateway-dialog-actions">
        <button type="button" disabled={disabled || !deviceId || !groupId} onClick={() => void mutate(
          `/api/admin/device-groups/${encodeURIComponent(groupId)}/devices/${encodeURIComponent(deviceId)}`, 'PUT')}>加入设备组</button>
        <button type="button" disabled={disabled || !deviceId || !groupId} onClick={() => void mutate(
          `/api/admin/device-groups/${encodeURIComponent(groupId)}/devices/${encodeURIComponent(deviceId)}`, 'DELETE')}>移出设备组</button>
      </div>
      <label htmlFor="managed-department-choice">设备所属部门</label>
      <select id="managed-department-choice" value={departmentId} onChange={event => setDepartmentId(event.target.value)} disabled={busy}>
        <option value="">未分配部门</option>{departments.map(department => <option key={department.id}
          value={department.id}>{department.display_name}</option>)}
      </select>
      <button type="button" disabled={disabled || !deviceId} onClick={() => void mutate(
        `/api/admin/devices/${encodeURIComponent(deviceId)}/department`, 'PUT', { department_id: departmentId || null })}>保存部门归属</button>
      <label htmlFor="device-scope-password">输入你的密码确认</label>
      <input id="device-scope-password" type="password" autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} disabled={busy} />
      {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" />正在保存管理范围…</p>}
      <button type="button" disabled={busy || loading} onClick={() => setRevision(value => value + 1)}>刷新列表</button>
    </div>
  </section>
}
