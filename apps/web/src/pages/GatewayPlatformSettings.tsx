import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import { useEffect, useState, useRef } from 'react'
import { useI18n } from '../i18n'
import Icon from '../components/Icon'
import ConfirmDialog from '../components/ConfirmDialog'
import { useManagedModeStore } from '../stores/managedModeStore'
import { gatewayConnectionState, useGatewayConnection, useGatewayConnectionStore, type GatewayConnection } from '../stores/gatewayConnectionStore'
import './GatewayPlatformSettings.css'
import { gatewayLoginFailure, GatewayLoginFailure } from '../utils/gatewayLoginError'

type PlatformState = GatewayConnection

function isPrivateGatewayHost(host: string): boolean {
 const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' ||
  (/^127\.\d+\.\d+\.\d+$/.test(host) && host.split('.').every(part => Number(part) <= 255))
 const ipv4 = host.split('.').map(Number)
 const privateIpv4 = ipv4.length === 4 && ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255) &&
  (ipv4[0] === 10 || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) || (ipv4[0] === 192 && ipv4[1] === 168))
 const privateIpv6 = /^\[(?:fc|fd)[0-9a-f:]+\]$/i.test(host)
 return loopback || privateIpv4 || privateIpv6
}

export function validGatewayPlatformUrl(value: string): boolean {
 try { const u = new URL(value.trim()); return !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && (u.protocol === 'https:' || (u.protocol === 'http:' && isPrivateGatewayHost(u.hostname))) } catch { return false }
}
export default function GatewayPlatformSettings() {
 const { t } = useI18n()
 const remoteReadOnly = isGatewayRemoteBrowser()
 const { status: state } = useGatewayConnection()
 const setState = (status: PlatformState) => useGatewayConnectionStore.setState({ status })
 const [url, setUrl] = useState('')
 const [enabled, setEnabled] = useState(false)
 const validSettings = url.trim() ? validGatewayPlatformUrl(url) : !enabled
 const [error, setError] = useState('')
 const [busy, setBusy] = useState(false)
 const [confirm, setConfirm] = useState(false)
 const [failure, setFailure] = useState<{ error: GatewayLoginFailure; url: string } | null>(null)
 const [failureOpen, setFailureOpen] = useState(false)
 const [revision, setRevision] = useState(0)
 const submitting = useRef(false)
 const refreshing = useRef(false)
 useEffect(() => {
  const returned = () => { if (submitting.current && !refreshing.current) { refreshing.current = true; setRevision(n => n+1) } }
  window.addEventListener('focus', returned)
  return () => window.removeEventListener('focus', returned)
 }, [])
 useEffect(() => {
  const controller = new AbortController()
  void useGatewayConnectionStore.getState().refresh().then(data => {
   if (!controller.signal.aborted) {
    setState(data); setUrl(data.url); setEnabled(data.enabled ?? data.authenticated); refreshing.current = false
    if (submitting.current) {
     submitting.current = false; setBusy(false)
     if (data.authenticated) window.location.reload()
    }
   }
  }).catch(() => { if (!controller.signal.aborted) { refreshing.current = false; setError(t('gatewayPlatform.loadError')) } })
  return () => controller.abort()
 }, [revision, t])
 async function connect(reset = false) {
  if (remoteReadOnly || state?.package_locked || submitting.current || !state || !validSettings) return
  submitting.current = true
  setBusy(true); setError(''); setFailureOpen(false)
  try {
   const origin = url.trim().replace(/\/$/, '')
   if (reset) {
    if (!failure || failure.url !== origin || !failure.error.fingerprint) throw new GatewayLoginFailure(t('gatewayPlatform.settingsChanged'))
    const response = await gatewayFetch('/api/gateway-platform/reset-trust', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({url: origin, fingerprint: failure.error.fingerprint}) })
    if (!response.ok) throw await gatewayLoginFailure(response, t)
    setState(await response.json()); setFailure(null)
   }
   const settingsResponse = await gatewayFetch('/api/gateway-platform/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: origin, enabled }) })
   if (!settingsResponse.ok) throw await gatewayLoginFailure(settingsResponse, t)
   const saved = await settingsResponse.json() as PlatformState
   setState(saved); setEnabled(saved.enabled); setUrl(saved.url)
   if (!saved.enabled || (saved.authenticated && !saved.authorization_required)) {
    setFailure(null)
    submitting.current = false; setBusy(false)
    if (!saved.enabled) useManagedModeStore.setState({ managed: false })
    return
   }
   const response = await gatewayFetch('/api/gateway-platform/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim().replace(/\/$/, '') }) })
   if (!response.ok) throw await gatewayLoginFailure(response, t)
   const data = await response.json().catch(() => { throw new GatewayLoginFailure(t('gatewayPlatform.invalidResponse')) })
   let target: URL
   try { target = new URL(data.authorization_url) } catch { throw new GatewayLoginFailure(t('gatewayPlatform.invalidResponse')) }
   if (target.origin !== new URL(url.trim()).origin || target.pathname !== '/desktop/login') throw new GatewayLoginFailure(t('gatewayPlatform.invalidResponse'))
   setFailure(null)
   window.location.assign(target.href)
  } catch (error) {
   const failed = error instanceof GatewayLoginFailure ? error : new GatewayLoginFailure(t('gatewayPlatform.unreachable'))
   setError(failed.message); setFailure({error: failed, url: url.trim().replace(/\/$/, '')}); setFailureOpen(true)
   setBusy(false); submitting.current = false
  }
 }
 return <section className="gateway-platform-settings">
  <h1>{t('gatewayPlatform.title')}</h1><p>{t(remoteReadOnly ? 'gatewayPlatform.remoteReadOnlyHint' : 'gatewayPlatform.intro')}</p>
  {!state && !error && <p role="status"><Icon className="gateway-platform-spinner" name="loader-circle" size={16} /> {t('gatewayPlatform.loading')}</p>}
  {error && <p role="alert">{error} <button type="button" disabled={busy} onClick={() => {
   if (failure) { if (failure.error.code === 'gateway_key_changed') setFailureOpen(true); else void connect() }
   else { setError(''); setRevision(n => n+1) }
  }}>{t(failure?.error.code === 'gateway_key_changed' ? 'gatewayPlatform.resetTrust' : 'gatewayPlatform.retry')}</button></p>}
  {state && <>
   <p role="status">{gatewayConnectionState(state) === 'connecting' && <Icon name="loader-circle" size={16} className="gateway-platform-spinner" />} {t(`gatewayPlatform.${gatewayConnectionState(state)}`)}</p>
   <form className={remoteReadOnly ? 'gateway-platform-form--readonly' : undefined} aria-disabled={remoteReadOnly || undefined} onSubmit={event => { event.preventDefault(); if (remoteReadOnly || state.package_locked || !validSettings) return; if (enabled && state.authenticated && state.url !== url.trim().replace(/\/$/, '')) setConfirm(true); else void connect() }}>
    <label htmlFor="gateway-platform-url">{t('gatewayPlatform.address')}</label>
    <input id="gateway-platform-url" type="url" value={url} disabled={remoteReadOnly || busy || state.package_locked} placeholder="http://localhost:8700" onChange={event => setUrl(event.target.value)} />
    <p className="gateway-platform-hint">{t('gatewayPlatform.addressHint')}</p>
    <label className="gateway-platform-mode" htmlFor="gateway-platform-enabled">
     <input id="gateway-platform-enabled" type="checkbox" checked={enabled} disabled={remoteReadOnly || busy || state.package_locked} onChange={event => setEnabled(event.target.checked)} />
     {t('gatewayPlatform.enable')}
    </label>
    <p className="gateway-platform-hint">{t('gatewayPlatform.modeHint')}</p>
    <button type="submit" disabled={remoteReadOnly || busy || state.package_locked || !validSettings}>{busy && <Icon name="loader-circle" size={16} className="gateway-platform-spinner" />}{busy ? t('gatewayPlatform.saving') : t('gatewayPlatform.save')}</button>
   </form>
  <ConfirmDialog open={confirm} title={t('gatewayPlatform.changeTitle')} message={t('gatewayPlatform.changeMessage')}
   onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void connect() }} />
  <ConfirmDialog open={failureOpen} title={t(failure?.error.code === 'gateway_key_changed' ? 'gatewayPlatform.keyChangedTitle' : 'gatewayPlatform.failureTitle')}
   message={failure?.error.message} danger={failure?.error.code === 'gateway_key_changed'}
   confirmText={t(failure?.error.code === 'gateway_key_changed' ? 'gatewayPlatform.resetTrust' : 'gatewayPlatform.retry')}
   onCancel={() => setFailureOpen(false)} onConfirm={() => void connect(failure?.error.code === 'gateway_key_changed')} />
  </>}
 </section>
}
