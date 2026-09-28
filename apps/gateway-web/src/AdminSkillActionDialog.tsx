import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export type SkillAction =
  | { kind: 'create' }
  | { kind: 'upload'; skillId: string }
  | { kind: 'approve'; skillId: string; versionId: string; version: string }
  | { kind: 'revoke'; skillId: string; versionId: string; version: string }
  | { kind: 'grant'; groupId: string; versionId: string }
  | { kind: 'revoke_grant'; groupId: string; skillId: string; name: string }

const titles = { create: '创建 Skill', upload: '上传版本', approve: '批准版本',
  revoke: '撤销版本', grant: '授权用户组', revoke_grant: '撤销组授权' }
const confirms = { create: '确认创建', upload: '确认上传', approve: '确认批准',
  revoke: '确认撤销', grant: '确认授权', revoke_grant: '确认撤销' }

export function AdminSkillActionDialog({ action, csrf, onDone, onClose }: {
  action: SkillAction; csrf: string; onDone: (createdId?: string) => void; onClose: () => void
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [version, setVersion] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)

  const valid = Boolean(csrf && password && (action.kind !== 'create' ||
    (name.trim() === name && name && /^[a-z0-9][a-z0-9-]*$/.test(slug))) &&
    (action.kind !== 'upload' || (version && file && file.size > 0 && file.size <= 8 * 1024 * 1024)) &&
    (action.kind !== 'revoke' || reason.trim()))
  const dirty = Boolean(name || slug || description || version || file || reason || password)

  async function submit() {
    if (!valid || busy) return
    setBusy(true); setError('')
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
    try {
      const step = await fetch('/api/auth/step-up', { method: 'POST',
        credentials: 'same-origin', headers, body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('管理员密码验证失败。')
      let url: string
      let method = 'POST'
      let body: Record<string, unknown> | undefined
      if (action.kind === 'create') {
        url = '/api/admin/skills'
        body = { name, slug, description }
      } else if (action.kind === 'upload') {
        url = `/api/admin/skills/${action.skillId}/versions`
        const bytes = new Uint8Array(await file!.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
        }
        body = { version, archive_base64: btoa(binary) }
      } else if (action.kind === 'approve' || action.kind === 'revoke') {
        url = `/api/admin/skills/${action.skillId}/versions/${action.versionId}/${action.kind}`
        if (action.kind === 'revoke') body = { reason: reason.trim() }
      } else if (action.kind === 'grant') {
        url = `/api/admin/groups/${action.groupId}/skills`
        body = { skill_version_id: action.versionId }
      } else {
        url = `/api/admin/groups/${action.groupId}/skills/${action.skillId}`
        method = 'DELETE'
      }
      const response = await fetch(url, { method, credentials: 'same-origin', headers,
        body: body ? JSON.stringify(body) : undefined })
      if (!response.ok) throw new Error(response.status === 409
        ? '操作冲突：请先处理已有项目分配或刷新版本状态。' : 'Skill 操作失败。')
      const result = method === 'DELETE' ? null : await response.json()
      onDone(action.kind === 'create' ? result?.id : undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Skill 操作失败。')
    } finally { setBusy(false) }
  }

  return <><GatewayConfirmDialog title={titles[action.kind]} message={
    action.kind === 'revoke_grant' ? `确认撤销用户组对“${action.name}”的授权？` :
      action.kind === 'revoke' ? '撤销版本后，所有使用该版本的项目分配将失效。' :
        '此操作需要 Skill 管理员二次认证。'
  } confirmLabel={confirms[action.kind]} busy={busy} disabled={!valid}
  onConfirm={() => void submit()} onCancel={() => dirty ? setDiscard(true) : onClose()}>
    <div className="gateway-usage-filters">
      {action.kind === 'create' && <>
        <label>名称<input value={name} maxLength={256} onChange={event => setName(event.target.value)} /></label>
        <label>标识<input value={slug} maxLength={128} onChange={event => setSlug(event.target.value)} /></label>
        <label>说明<input value={description} maxLength={2000}
          onChange={event => setDescription(event.target.value)} /></label>
      </>}
      {action.kind === 'upload' && <>
        <label>版本号<input value={version} maxLength={64}
          onChange={event => setVersion(event.target.value)} /></label>
        <label>Skill ZIP 包<input type="file" accept=".zip,application/zip"
          onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
      </>}
      {action.kind === 'revoke' && <label>撤销原因<input value={reason} maxLength={512}
        onChange={event => setReason(event.target.value)} /></label>}
      <label>管理员密码<input type="password" autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} /></label>
    </div>
    {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在处理 Skill…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  </GatewayConfirmDialog>
  {discard && <GatewayConfirmDialog title="放弃 Skill 操作"
    message="已填写的字段将被清除。" confirmLabel="放弃并关闭" cancelLabel="继续编辑"
    onConfirm={onClose} onCancel={() => setDiscard(false)} />}</>
}
