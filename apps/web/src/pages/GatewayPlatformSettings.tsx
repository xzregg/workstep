import { useEffect, useState, useRef } from 'react'
import { useI18n } from '../i18n'
import Icon from '../components/Icon'
import ConfirmDialog from '../components/ConfirmDialog'
import { useManagedModeStore } from '../stores/managedModeStore'
import './GatewayPlatformSettings.css'

type PlatformState = { url: string; enabled: boolean; authenticated: boolean; online: boolean; pending_device: boolean; package_locked: boolean }
export function validGatewayPlatformUrl(value: string): boolean {
 try { const u = new URL(value.trim()); return !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) } catch { return false }
}
export default function GatewayPlatformSettings() {
 const { t } = useI18n()
 const [state, setState] = useState<PlatformState | null>(null)
 const [url, setUrl] = useState('')
 const [enabled, setEnabled] = useState(false)
 const [error, setError] = useState('')
 const [busy, setBusy] = useState(false)
 const [confirm, setConfirm] = useState(false)
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
  void fetch('/api/gateway-platform/settings', { signal: controller.signal }).then(async response => {
   if (!response.ok) throw Error(t('gatewayPlatform.loadError'))
   const data = await response.json() as PlatformState
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
 async function connect() {
  if (submitting.current || !state || !validGatewayPlatformUrl(url)) return
  submitting.current = true
  setBusy(true); setError('')
  try {
   const origin = url.trim().replace(/\/$/, '')
   const settingsResponse = await fetch('/api/gateway-platform/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: origin, enabled }) })
   if (!settingsResponse.ok) throw Error(t('gatewayPlatform.saveError'))
   const saved = await settingsResponse.json() as PlatformState
   setState(saved); setEnabled(saved.enabled); setUrl(saved.url)
   if (!saved.enabled || saved.authenticated) {
    submitting.current = false; setBusy(false)
    if (!saved.enabled) useManagedModeStore.setState({ managed: false })
    return
   }
   const response = await fetch('/api/gateway-platform/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim().replace(/\/$/, '') }) })
   if (!response.ok) throw Error(t('gatewayPlatform.connectError'))
   const data = await response.json(); const target = new URL(data.authorization_url)
   if (target.origin !== new URL(url.trim()).origin || target.pathname !== '/desktop/login') throw Error(t('gatewayPlatform.connectError'))
   window.location.assign(target.href)
  } catch (error) { setError(error instanceof Error ? error.message : t('gatewayPlatform.connectError')); setBusy(false); submitting.current = false }
 }
 return <section className="gateway-platform-settings">
  <h1>{t('gatewayPlatform.title')}</h1><p>{t('gatewayPlatform.intro')}</p>
  {!state && !error && <p role="status"><Icon className="gateway-platform-spinner" name="loader-circle" size={16} /> {t('gatewayPlatform.loading')}</p>}
  {error && <p role="alert">{error} <button type="button" onClick={() => { setError(''); setRevision(n => n+1) }}>{t('gatewayPlatform.retry')}</button></p>}
  {state && <>
   <p role="status">{!state.enabled ? t('gatewayPlatform.disabled') : state.pending_device ? t('gatewayPlatform.pending') : state.online ? t('gatewayPlatform.online') : state.authenticated ? t('gatewayPlatform.connecting') : t('gatewayPlatform.notAuthenticated')}</p>
   <form onSubmit={event => { event.preventDefault(); if (state.authenticated && state.url !== url.trim().replace(/\/$/, '')) setConfirm(true); else void connect() }}>
    <label htmlFor="gateway-platform-url">{t('gatewayPlatform.address')}</label>
    <input id="gateway-platform-url" type="url" value={url} disabled={busy || state.package_locked} placeholder="http://localhost:8700" onChange={event => setUrl(event.target.value)} />
    <p className="gateway-platform-hint">{t('gatewayPlatform.addressHint')}</p>
    <label className="gateway-platform-mode" htmlFor="gateway-platform-enabled">
     <input id="gateway-platform-enabled" type="checkbox" checked={enabled} disabled={busy || state.package_locked} onChange={event => setEnabled(event.target.checked)} />
     {t('gatewayPlatform.enable')}
    </label>
    <p className="gateway-platform-hint">{t('gatewayPlatform.modeHint')}</p>
    <button type="submit" disabled={busy || state.package_locked || !validGatewayPlatformUrl(url)}>{busy && <Icon name="loader-circle" size={16} className="gateway-platform-spinner" />}{busy ? t('gatewayPlatform.saving') : t('gatewayPlatform.save')}</button>
   </form>
  <ConfirmDialog open={confirm} title={t('gatewayPlatform.changeTitle')} message={t('gatewayPlatform.changeMessage')}
   onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void connect() }} />
  </>}
 </section>
}
