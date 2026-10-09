import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { invitationTokenPattern } from './projectInvitationApi'

export function ProjectInvitationJoinForm() {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  function open(event: FormEvent) {
    event.preventDefault()
    const entered = value.trim()
    let token = entered
    if (!invitationTokenPattern.test(token)) {
      try {
        const url = new URL(entered)
        if (url.origin !== window.location.origin || url.search || url.hash) throw Error()
        token = url.pathname.match(/^\/project-invitations\/([A-Za-z0-9_-]{43})$/)?.[1] ?? ''
      } catch { token = '' }
    }
    if (!invitationTokenPattern.test(token)) { setError('请填写当前网关的项目邀请链接或邀请码。'); return }
    setError(''); navigate('/project-invitations/' + token)
  }
  return <section className="gateway-project-invitation-section">
    <h3>添加别人分享的项目</h3>
    <p>不需要拥有设备。登录后确认添加，即可在授权范围内进入对方的项目。</p>
    <form className="gateway-auth-form" onSubmit={open}>
      <label htmlFor="project-invitation-input">项目邀请链接或邀请码</label>
      <input id="project-invitation-input" value={value} onChange={event => { setValue(event.target.value); setError('') }} />
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
      <button type="submit" disabled={!value.trim()}>查看邀请</button>
    </form>
  </section>
}
