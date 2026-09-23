import { useEffect, useState } from 'react'
import { gitApi, type GitCredentialStatus } from '../../api/git'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'

export default function GitRepositorySettings({ id }: { id: string }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [inventory, setInventory] = useState<GitCredentialStatus | null>(null)
  const [remote, setRemote] = useState('')
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const validIdentity = !!name.trim() && /^[^@\s]+@[^@\s]+$/.test(email.trim())
  useEffect(() => {
    let current = true
    setError(''); setNotice(''); setInventory(null); setRemote('')
    Promise.all([gitApi.identity(id), gitApi.credentials(id)]).then(([identity, credentials]) => {
      if (!current) return
      setName(identity.name); setEmail(identity.email); setInventory(credentials)
      setRemote(credentials.remotes.find(item => item.url.startsWith('https://'))?.name || '')
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
    if (!remote || !username.trim() || !token || busy) return
    setBusy(true); setError(''); setNotice('')
    try { setInventory(await gitApi.saveCredentials(id, remote, username.trim(), token)); setToken(''); setNotice(t('git.credentialsSaved')) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  async function clearCredential() {
    if (!remote || busy) return
    setBusy(true); setError(''); setNotice('')
    try { setInventory(await gitApi.clearCredentials(id, remote)); setToken(''); setNotice(t('git.credentialsCleared')) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const selected = inventory?.remotes.find(item => item.name === remote)
  return <section className="git-repository-settings">
    <h2>{t('git.identityTitle')}</h2>
    <p>{t('git.identityHint')}</p>
    <label>{t('git.identityName')}<input name="gitIdentityName" value={name} onChange={event => setName(event.target.value)} /></label>
    <label>{t('git.identityEmail')}<input name="gitIdentityEmail" type="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
    <div className="git-repository-settings__actions"><Button variant="primary" loading={busy} disabled={!validIdentity || busy} onClick={() => void saveIdentity(true)}>{t('git.saveGlobalIdentity')}</Button><Button loading={busy} disabled={!validIdentity || busy} onClick={() => void saveIdentity()}>{t('git.saveIdentity')}</Button></div>
    <small>{t('git.globalIdentityHint')}</small>
    <h2>{t('git.credentialsTitle')}</h2>
    <p>{t('git.credentialsHint')}</p>
    <label>{t('git.remoteSource')}<select value={remote} onChange={event => { setRemote(event.target.value); setToken(''); setNotice('') }}><option value="">{t('git.selectRemote')}</option>{inventory?.remotes.filter(item => item.url.startsWith('https://')).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
    {selected && <><small>{selected.url}</small><label>{t('git.authUsername')}<input name="gitAuthUsername" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label><label>{t('git.authToken')}<input name="gitAuthToken" type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} /></label><div className="git-repository-settings__actions"><Button variant="primary" loading={busy} disabled={!username.trim() || !token || busy} onClick={() => void saveCredential()}>{t('git.saveCredentials')}</Button>{selected.configured && <Button disabled={busy} onClick={() => void clearCredential()}>{t('git.clearCredentials')}</Button>}</div>{selected.configured && <small><Icon name="check" size={13} />{t('git.credentialsConfigured')}</small>}</>}
    {inventory && !inventory.remotes.some(item => item.url.startsWith('https://')) && <p>{t('git.noHttpsRemote')}</p>}
    {error && <p role="alert" className="git-danger">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>
}
