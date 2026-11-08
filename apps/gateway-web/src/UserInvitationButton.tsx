import { useState } from 'react'

async function notify(kind: 'success' | 'error', text: string) {
  const { message } = await import('antd')
  void message[kind](text)
}

export function UserInvitationButton({ userId, csrf, disabled }: { userId: string; csrf: string; disabled: boolean }) {
  const [busy, setBusy] = useState(false)
  async function obtain() {
    if (busy) return
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/invitation`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error(response.status === 409 ? '账户状态已变化，请刷新列表。' : '获取邀请链接失败，请重试。')
      const result = await response.json()
      const url = new URL(result.url, window.location.origin).href
      try {
        await navigator.clipboard.writeText(url)
        void notify('success', '复制成功')
      } catch {
        void notify('error', '复制失败，请允许浏览器访问剪贴板后重试。')
      }
    } catch (reason) { void notify('error', reason instanceof Error ? reason.message : '获取邀请链接失败。') }
    finally { setBusy(false) }
  }
  return <span className="gateway-user-invitation">
    <button type="button" disabled={disabled || busy} onClick={() => void obtain()}>
      {busy && <span className="gateway-spinner" aria-hidden="true" />}获取邀请链接
    </button>
  </span>
}
