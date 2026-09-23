import { useEffect, useState } from 'react'
import { gitApi, type GitCredentialStatus } from '../../api/git'
import { ApiError } from '../../api/client'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'

function httpsHost(url: string) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.host.toLowerCase() : '' }
  catch { return '' }
}

export default function GitRepositorySettings({ id }: { id: string }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [inventory, setInventory] = useState<GitCredentialStatus | null>(null)
  const [host, setHost] = useState('')
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const validIdentity = !!name.trim() && /^[^@\s]+@[^@\s]+$/.test(email.trim())
  useEffect(() => {
    let current = true
    setError(''); setNotice(''); setInventory(null); setHost('')
    Promise.all([gitApi.identity(id), gitApi.credentials(id)]).then(([identity, response]) => {
      if (!current) return
      const credentials: GitCredentialStatus = { remotes: Array.isArray(response.remotes) ? response.remotes : [], hosts: Array.isArray(response.hosts) ? response.hosts : [] }
      setName(identity.name); setEmail(identity.email); setInventory(credentials)
      setHost(credentials.remotes.flatMap(item => [httpsHost(item.push_url), httpsHost(item.url)]).find(Boolean) || credentials.hosts[0] || '')
    }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { current = false }
  }, [id])
  async function saveIdentity(global = false) {
    if (!validIdentity || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const identity = { name: name.trim(), email: email.trim() }
      if (global) await gitApi.setGlobalIdentity(id, identity)
      await gitApi.setIdentity(id, identity)
      setNotice(t(global ? 'git.globalIdentitySaved' : 'git.identitySaved'))
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  async function saveCredential() {
    if (!host.trim() || !username.trim() || !token || busy) return
    setBusy(true); setError(''); setNotice('')
    try { const result = await gitApi.saveHostCredentials(host.trim(), username.trim(), token); setInventory(current => current && { ...current, hosts: Array.isArray(result.hosts) ? result.hosts : [] }); setToken(''); setNotice(t('git.credentialsSaved')) }
    catch (reason) { setError(reason instanceof ApiError && reason.status === 404 ? t('git.restartForCredentials') : reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  async function clearCredential() {
    if (!host.trim() || busy) return
    setBusy(true); setError(''); setNotice('')
    try { const result = await gitApi.clearHostCredentials(host.trim()); setInventory(current => current && { ...current, hosts: Array.isArray(result.hosts) ? result.hosts : [] }); setToken(''); setNotice(t('git.credentialsCleared')) }
    catch (reason) { setError(reason instanceof ApiError && reason.status === 404 ? t('git.restartForCredentials') : reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const suggestedHosts = [...new Set(inventory?.remotes.flatMap(item => [httpsHost(item.url), httpsHost(item.push_url)]).filter(Boolean) || [])]
  const configured = !!inventory?.hosts?.includes(host.trim().toLowerCase())
  return <section className="git-repository-settings">
    <h2>{t('git.identityTitle')}</h2>
    <p>{t('git.identityHint')}</p>
    <label>{t('git.identityName')}<input name="gitIdentityName" value={name} onChange={event => setName(event.target.value)} /></label>
    <label>{t('git.identityEmail')}<input name="gitIdentityEmail" type="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
    <div className="git-repository-settings__actions"><Button variant="primary" loading={busy} disabled={!validIdentity || busy} onClick={() => void saveIdentity(true)}>{t('git.saveGlobalIdentity')}</Button><Button loading={busy} disabled={!validIdentity || busy} onClick={() => void saveIdentity()}>{t('git.saveIdentity')}</Button></div>
    <small>{t('git.globalIdentityHint')}</small>
    <h2>{t('git.credentialsTitle')}</h2>
    <p>{t('git.credentialsHint')}</p>
    <label>{t('git.httpsHost')}<input name="gitAuthHost" list="git-auth-hosts" value={host} placeholder="gitlab.example.com" onChange={event => { setHost(event.target.value); setToken(''); setNotice('') }} /><datalist id="git-auth-hosts">{suggestedHosts.map(value => <option key={value} value={value} />)}</datalist></label>
    <small>{t('git.httpsHostHint')}</small>
    <label>{t('git.authUsername')}<input name="gitAuthUsername" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label><label>{t('git.authToken')}<input name="gitAuthToken" type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} /></label><div className="git-repository-settings__actions"><Button variant="primary" loading={busy} disabled={!host.trim() || !username.trim() || !token || busy} onClick={() => void saveCredential()}>{t('git.saveCredentials')}</Button>{configured && <Button disabled={busy} onClick={() => void clearCredential()}>{t('git.clearCredentials')}</Button>}</div>{configured && <small><Icon name="check" size={13} />{t('git.credentialsConfigured')}</small>}
    {error && <p role="alert" className="git-danger">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>
}
