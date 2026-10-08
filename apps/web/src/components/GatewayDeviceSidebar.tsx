import { useEffect, useRef, useState } from 'react'
import { ApiError, request } from '../api/transport'
import { useI18n } from '../i18n'
import Spinner from './Spinner'

type Device = {id: string; name: string; online: boolean}
export default function GatewayDeviceSidebar({currentDeviceId}: {currentDeviceId: string}) {
  const {t} = useI18n()
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const pending = useRef(false)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        const result = await request<{devices: Device[]}>('/remote/devices')
        if (active) {setDevices(result.devices); setError('')}
      } catch { if (active) setError(t('gatewayRemote.devicesFailed')) }
      finally {if (active) {setLoading(false); timer = setTimeout(() => void refresh(), 20000)}}
    }
    setLoading(true)
    void refresh()
    return () => {active = false; clearTimeout(timer)}
  }, [revision, t])
  async function select(device: Device) {
    if (pending.current || !device.online || device.id === currentDeviceId) return
    pending.current = true; setOpening(device.id); setError('')
    try {
      const access = await request<{url: string; ticket: string}>(`/remote/devices/${encodeURIComponent(device.id)}/access`)
      const form = document.createElement('form')
      form.method = 'POST'; form.action = new URL('api/remote/redeem', access.url).toString()
      const ticket = document.createElement('input')
      ticket.type = 'hidden'; ticket.name = 'ticket'; ticket.value = access.ticket
      form.append(ticket); document.body.append(form)
      try {form.submit()} finally {form.remove()}
    } catch (reason) {
      setError(t(reason instanceof ApiError && reason.status === 409 ? 'gatewayRemote.deviceOffline' : 'gatewayRemote.switchFailed'))
      pending.current = false; setOpening(null)
    }
  }
  return <aside className="gateway-device-sidebar" aria-label={t('gatewayRemote.devices')}>
    <h2>{t('gatewayRemote.devices')}</h2>
    {loading && <p role="status"><Spinner size={16}/>{t('gatewayRemote.loading')}</p>}
    {devices.map(device => <button type="button" key={device.id} className="gateway-device-choice"
      aria-pressed={device.id === currentDeviceId} disabled={!device.online || opening !== null}
      onClick={() => void select(device)} title={device.name}>
      <span>{device.name}</span><small>{opening === device.id ? <Spinner size={16}/> : t(device.online ? 'gatewayRemote.online' : 'gatewayRemote.deviceOffline')}</small>
    </button>)}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="btn-ghost" disabled={loading || opening !== null} onClick={() => setRevision(value => value + 1)}>{t('gatewayRemote.refreshDevices')}</button>
  </aside>
}
