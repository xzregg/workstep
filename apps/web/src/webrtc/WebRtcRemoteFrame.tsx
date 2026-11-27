import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import Button from '../components/Button'
import Field from '../components/Field'
import Icon from '../components/Icon'
import Input from '../components/Input'
import Spinner from '../components/Spinner'
import StatusBadge from '../components/StatusBadge'
import { connectWebRtcDirect, fetchWebRtcDeviceConfig, type WebRtcConnectionHandle } from './peerClient'
import { installGlobalWebRtcTransport, shouldProxyWebRtcHttp } from './transportAdapter'
import { formatLatencyDisplay, useWebRtcConnectionStore } from './webrtcConnectionStore'
import { isWebRtcRemoteBrowser, webrtcDeviceIdFromPath } from './webrtcLocation'
import '../components/GatewayConnectionStatus.css'
import './WebRtcRemoteFrame.css'

const PAIR_KEY_STORAGE_PREFIX = 'workstep-webrtc-pair-key:'
const AUTO_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000] as const
export const WEBRTC_HEARTBEAT_INTERVAL_MS = 10000
export const WEBRTC_NET_CHANGE_PROBE_TIMEOUT_MS = 1500

type NetworkConnectionEventTarget = Navigator & {
  connection?: EventTarget
}

function loadSessionPairKey(deviceId: string): string {
  if (!deviceId || typeof sessionStorage === 'undefined') return ''
  try {
    return sessionStorage.getItem(PAIR_KEY_STORAGE_PREFIX + deviceId) ?? ''
  } catch {
    return ''
  }
}

function saveSessionPairKey(deviceId: string, key: string): void {
  if (!deviceId || typeof sessionStorage === 'undefined') return
  try {
    if (key) sessionStorage.setItem(PAIR_KEY_STORAGE_PREFIX + deviceId, key)
    else sessionStorage.removeItem(PAIR_KEY_STORAGE_PREFIX + deviceId)
  } catch {
    /* ignore storage failures */
  }
}

export default function WebRtcRemoteFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const active = isWebRtcRemoteBrowser()
  const deviceId = active ? webrtcDeviceIdFromPath() : ''

  const [deviceName, setDeviceName] = useState(deviceId)
  const [deviceOnline, setDeviceOnline] = useState<boolean | null>(null)
  const [sessionAuthorized, setSessionAuthorized] = useState(false)
  const [pairKey, setPairKey] = useState(() => loadSessionPairKey(deviceId))
  const [showKey, setShowKey] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
  const [errorText, setErrorText] = useState('')
  const [handle, setHandle] = useState<WebRtcConnectionHandle | null>(null)
  const latencyMs = useWebRtcConnectionStore((state) => state.latencyMs)

  const handleRef = useRef<WebRtcConnectionHandle | null>(null)
  const restoreTransportRef = useRef<(() => void) | null>(null)
  const blobCacheRef = useRef(new Map<string, string>())
  const connectAttemptRef = useRef(0)
  const sessionAuthorizedRef = useRef(false)
  const manualDisconnectedRef = useRef(false)
  const hasConnectedRef = useRef(false)
  const autoRetryCountRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const isConnectingRef = useRef(false)
  const periodicProbeInFlightRef = useRef(false)
  const netProbeInFlightRef = useRef(false)
  const missedPingsRef = useRef(0)
  const connectedAtRef = useRef(0)
  const mountedRef = useRef(true)

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const releaseConnection = useCallback(() => {
    restoreTransportRef.current?.()
    restoreTransportRef.current = null
    handleRef.current?.close()
    handleRef.current = null
  }, [])

  const teardownTransport = useCallback(() => {
    clearReconnectTimer()
    releaseConnection()
    missedPingsRef.current = 0
    periodicProbeInFlightRef.current = false
    netProbeInFlightRef.current = false
    for (const blobUrl of blobCacheRef.current.values()) {
      URL.revokeObjectURL(blobUrl)
    }
    blobCacheRef.current.clear()
    setHandle(null)
    useWebRtcConnectionStore.setState({ connected: false, reconnecting: false, latencyMs: null, deviceName: '' })
  }, [clearReconnectTimer, releaseConnection])

  const startConnect = useCallback(async (
    secret: string,
    options?: { sessionAuthorized?: boolean; isAutoReconnect?: boolean },
  ) => {
    const trimmed = secret.trim()
    const allowEmpty = Boolean(options?.sessionAuthorized)
    const isAutoReconnect = Boolean(options?.isAutoReconnect)
    if (!deviceId || (!trimmed && !allowEmpty)) return

    manualDisconnectedRef.current = false
    clearReconnectTimer()
    if (!isAutoReconnect) {
      autoRetryCountRef.current = 0
    }
    const attempt = ++connectAttemptRef.current
    isConnectingRef.current = true
    if (isAutoReconnect || hasConnectedRef.current) {
      releaseConnection()
    } else {
      teardownTransport()
    }
    setPhase(hasConnectedRef.current ? 'reconnecting' : 'connecting')
    useWebRtcConnectionStore.setState((prev) => ({
      connected: false,
      reconnecting: hasConnectedRef.current,
      latencyMs: null,
      deviceName: prev.deviceName,
    }))
    setErrorText('')

    const scheduleReconnect = () => {
      if (!mountedRef.current || manualDisconnectedRef.current || connectAttemptRef.current !== attempt) return
      const saved = loadSessionPairKey(deviceId)
      const authorized = sessionAuthorizedRef.current
      const retryIdx = autoRetryCountRef.current
      if ((!saved && !authorized) || retryIdx >= AUTO_RECONNECT_DELAYS_MS.length) {
        hasConnectedRef.current = false
        teardownTransport()
        setPhase('error')
        setErrorText(t('webrtcP2p.disconnected'))
        return
      }
      autoRetryCountRef.current = retryIdx + 1
      setPhase('reconnecting')
      useWebRtcConnectionStore.setState((prev) => ({
        connected: false,
        reconnecting: true,
        latencyMs: null,
        deviceName: prev.deviceName,
      }))
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null
        if (!mountedRef.current || manualDisconnectedRef.current || connectAttemptRef.current !== attempt) return
        void startConnect(saved, { sessionAuthorized: sessionAuthorizedRef.current, isAutoReconnect: true })
      }, AUTO_RECONNECT_DELAYS_MS[retryIdx])
    }

    try {
      const nextHandle = await connectWebRtcDirect({ deviceId, pairKey: trimmed })
      if (!mountedRef.current || attempt !== connectAttemptRef.current) {
        nextHandle.close()
        return
      }
      isConnectingRef.current = false
      autoRetryCountRef.current = 0
      hasConnectedRef.current = true
      missedPingsRef.current = 0
      periodicProbeInFlightRef.current = false
      netProbeInFlightRef.current = false
      connectedAtRef.current = Date.now()
      if (trimmed) {
        saveSessionPairKey(deviceId, trimmed)
      }
      const initialLatency = nextHandle.candidateInfo.rttMs !== null && Number.isFinite(nextHandle.candidateInfo.rttMs)
        ? Math.max(0, Math.round(nextHandle.candidateInfo.rttMs))
        : null
      restoreTransportRef.current = installGlobalWebRtcTransport(nextHandle.transport)
      handleRef.current = nextHandle
      setDeviceName(nextHandle.deviceName)
      setDeviceOnline(true)
      setHandle(nextHandle)
      setPhase('connected')
      useWebRtcConnectionStore.setState({
        connected: true,
        reconnecting: false,
        latencyMs: initialLatency,
        deviceName: nextHandle.deviceName,
      })
      if (isAutoReconnect) {
        window.dispatchEvent(new Event('workstep:resume'))
      }

      void nextHandle.waitClosed.then((reason) => {
        if (!mountedRef.current || attempt !== connectAttemptRef.current || manualDisconnectedRef.current) return
        if (reason === 'user_closed') return
        if (reason === 'relay_not_allowed') {
          hasConnectedRef.current = false
          teardownTransport()
          setPhase('error')
          setErrorText(t('webrtcP2p.relayRejected'))
          return
        }
        releaseConnection()
        scheduleReconnect()
      })
    } catch (err) {
      if (!mountedRef.current || attempt !== connectAttemptRef.current) return
      isConnectingRef.current = false
      const msg = err instanceof Error ? err.message : String(err)
      if (allowEmpty && !trimmed && !/relay|ice|timeout|timed out/i.test(msg)) {
        sessionAuthorizedRef.current = false
        setSessionAuthorized(false)
      }
      if (isAutoReconnect && !/relay/i.test(msg) && (loadSessionPairKey(deviceId) || sessionAuthorizedRef.current)
        && autoRetryCountRef.current < AUTO_RECONNECT_DELAYS_MS.length) {
        releaseConnection()
        scheduleReconnect()
        return
      }
      hasConnectedRef.current = false
      teardownTransport()
      setPhase('error')
      setErrorText(/relay/i.test(msg) ? t('webrtcP2p.relayRejected') : msg)
    }
  }, [clearReconnectTimer, deviceId, releaseConnection, t, teardownTransport])

  useEffect(() => {
    mountedRef.current = true
    if (!active || !deviceId) return
    let mounted = true
    manualDisconnectedRef.current = false
    hasConnectedRef.current = false
    autoRetryCountRef.current = 0
    sessionAuthorizedRef.current = false
    setSessionAuthorized(false)
    const initialAttempt = connectAttemptRef.current
    const savedKey = loadSessionPairKey(deviceId)
    if (savedKey) {
      void startConnect(savedKey)
    }
    void fetchWebRtcDeviceConfig(deviceId).then((cfg) => {
      if (!mounted) return
      setDeviceOnline(cfg.online)
      if (cfg.device_name) setDeviceName(cfg.device_name)
      const authorized = Boolean(cfg.session_authorized)
      sessionAuthorizedRef.current = authorized
      setSessionAuthorized(authorized)
      if (
        !savedKey
        && !manualDisconnectedRef.current
        && cfg.online
        && authorized
        && connectAttemptRef.current === initialAttempt
        && !handleRef.current
      ) {
        void startConnect('', { sessionAuthorized: true })
      }
    }).catch(() => undefined)

    return () => {
      mounted = false
      mountedRef.current = false
      isConnectingRef.current = false
      connectAttemptRef.current += 1
      teardownTransport()
    }
  }, [active, deviceId, startConnect, teardownTransport])

  const runPingProbe = useCallback(async (timeoutMs: number, reconnectOnFirstFailure: boolean) => {
    const current = handleRef.current
    if (!current || !current.transport.isOpen || isConnectingRef.current || manualDisconnectedRef.current) {
      return
    }
    const lockRef = reconnectOnFirstFailure ? netProbeInFlightRef : periodicProbeInFlightRef
    if (lockRef.current) return
    lockRef.current = true
    try {
      const measuredMs = await current.transport.ping(timeoutMs)
      if (!mountedRef.current || handleRef.current !== current) return
      missedPingsRef.current = 0
      useWebRtcConnectionStore.setState((prev) => (prev.connected ? { latencyMs: measuredMs } : prev))
    } catch {
      if (!mountedRef.current || handleRef.current !== current || manualDisconnectedRef.current) return
      missedPingsRef.current += 1
      if (reconnectOnFirstFailure || missedPingsRef.current >= 2) {
        missedPingsRef.current = 0
        const saved = loadSessionPairKey(deviceId)
        if (saved || sessionAuthorizedRef.current) {
          void startConnect(saved, {
            sessionAuthorized: sessionAuthorizedRef.current,
            isAutoReconnect: true,
          })
        }
      }
    } finally {
      lockRef.current = false
    }
  }, [deviceId, startConnect])

  // Measure live RTT immediately upon connect and every 10s while the tab stays visible.
  useEffect(() => {
    if (!active || phase !== 'connected' || !handle) return
    void runPingProbe(3000, false)
    const timerId = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void runPingProbe(3000, false)
    }, WEBRTC_HEARTBEAT_INTERVAL_MS)
    return () => window.clearInterval(timerId)
  }, [active, handle, phase, runPingProbe])

  // Auto-reconnect when mobile network switches or browser returns to foreground.
  useEffect(() => {
    if (!active || !deviceId) return
    const triggerRecover = (isNetworkEvent: boolean) => {
      if (manualDisconnectedRef.current) return
      const saved = loadSessionPairKey(deviceId)
      if (!saved && !sessionAuthorizedRef.current) return
      if (isConnectingRef.current && reconnectTimerRef.current === null && !isNetworkEvent) return
      const current = handleRef.current
      if (
        !current
        || !current.transport.isOpen
        || current.peerConnection.iceConnectionState === 'failed'
        || current.peerConnection.iceConnectionState === 'closed'
      ) {
        void startConnect(saved, {
          sessionAuthorized: sessionAuthorizedRef.current,
          isAutoReconnect: hasConnectedRef.current,
        })
        return
      }
      if (!isNetworkEvent && Date.now() - connectedAtRef.current < 500) {
        return
      }
      void runPingProbe(WEBRTC_NET_CHANGE_PROBE_TIMEOUT_MS, true)
    }
    const onNetworkChange = () => triggerRecover(true)
    const onResume = () => triggerRecover(false)
    const onVisible = () => {
      if (document.visibilityState === 'visible') onResume()
    }
    const connection = (navigator as NetworkConnectionEventTarget).connection
    window.addEventListener('online', onNetworkChange)
    window.addEventListener('workstep:resume', onResume)
    document.addEventListener('visibilitychange', onVisible)
    connection?.addEventListener?.('change', onNetworkChange)
    return () => {
      window.removeEventListener('online', onNetworkChange)
      window.removeEventListener('workstep:resume', onResume)
      document.removeEventListener('visibilitychange', onVisible)
      connection?.removeEventListener?.('change', onNetworkChange)
    }
  }, [active, deviceId, runPingProbe, startConnect])

  // Rewrite same-origin media `src` elements inside the connected workspace to Blob URLs fetched over DataChannel.
  useEffect(() => {
    if (!active || phase !== 'connected' || typeof MutationObserver === 'undefined') return
    const MEDIA_SELECTOR = 'img[src], audio[src], video[src], source[src]'
    const rewriteMedia = (el: HTMLElement) => {
      if (!(el instanceof HTMLImageElement || el instanceof HTMLAudioElement || el instanceof HTMLVideoElement || el instanceof HTMLSourceElement)) {
        return
      }
      const rawSrc = (el.getAttribute('src') || '').trim()
      if (!rawSrc || rawSrc.startsWith('blob:') || rawSrc.startsWith('data:') || !shouldProxyWebRtcHttp(rawSrc)) {
        return
      }
      const cached = blobCacheRef.current.get(rawSrc)
      if (cached) {
        el.src = cached
        return
      }
      void globalThis.fetch(rawSrc).then(async (res) => {
        if (!res.ok) return
        const url = URL.createObjectURL(await res.blob())
        blobCacheRef.current.set(rawSrc, url)
        if ((el.getAttribute('src') || '').trim() === rawSrc) {
          el.src = url
        }
      }).catch(() => undefined)
    }
    document.querySelectorAll(MEDIA_SELECTOR).forEach((node) => rewriteMedia(node as HTMLElement))
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
          rewriteMedia(mutation.target)
          continue
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue
          if (node.matches(MEDIA_SELECTOR)) rewriteMedia(node as HTMLElement)
          node.querySelectorAll(MEDIA_SELECTOR).forEach((media) => rewriteMedia(media as HTMLElement))
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
    return () => observer.disconnect()
  }, [active, phase])

  if (!active) return <>{children}</>

  if ((phase === 'connected' && handle) || (phase === 'reconnecting' && hasConnectedRef.current)) {
    const info = handle?.candidateInfo
    const latencyDisplay = formatLatencyDisplay(latencyMs)
    return (
      <div className="webrtc-remote-frame" data-webrtc-connected={phase === 'connected' ? 'true' : undefined}>
        <div className="webrtc-remote-banner">
          <div className="webrtc-remote-meta">
            <span className="webrtc-remote-device">{deviceName}</span>
            {phase === 'connected' && info ? (
              <>
                <StatusBadge status="completed" label={t('webrtcP2p.directConnected')} />
                <span className="webrtc-remote-path" data-testid="webrtc-candidate-path">
                  {info.localType} ↔ {info.remoteType}
                </span>
                {latencyDisplay.valid && (
                  <span
                    className={`webrtc-remote-latency gateway-connection-latency${latencyDisplay.modifierClass}`}
                    data-testid="webrtc-latency"
                  >
                    · {latencyDisplay.value} ms
                  </span>
                )}
              </>
            ) : (
              <StatusBadge status="running" loading label={t('webrtcP2p.connecting')} />
            )}
          </div>
          <div className="webrtc-remote-actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void startConnect(loadSessionPairKey(deviceId) || pairKey, { sessionAuthorized })}
            >
              <Icon name="refresh" size={14} />
              {t('webrtcP2p.reconnect')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                manualDisconnectedRef.current = true
                hasConnectedRef.current = false
                autoRetryCountRef.current = 0
                saveSessionPairKey(deviceId, '')
                connectAttemptRef.current += 1
                teardownTransport()
                setPhase('idle')
              }}
            >
              {t('webrtcP2p.disconnect')}
            </Button>
          </div>
        </div>
        <div className="webrtc-remote-content">{children}</div>
      </div>
    )
  }

  return (
    <div className="modal-overlay">
      <div className="modal webrtc-pair-card" role="dialog" aria-modal="true" aria-label={t('webrtcP2p.connectTitle')}>
        <div className="modal-header">
          <span className="modal-title">{deviceName || t('webrtcP2p.connectTitle')}</span>
          {deviceOnline === false && <StatusBadge status="failed" label={t('webrtcP2p.deviceOffline')} />}
        </div>
        <div className="modal-body">
          <form
            className="webrtc-pair-form"
            onSubmit={(event) => {
              event.preventDefault()
              if ((pairKey.trim() || sessionAuthorized) && phase !== 'connecting') {
                void startConnect(pairKey, { sessionAuthorized })
              }
            }}
          >
            <Field label={t('webrtcP2p.pairKey')} htmlFor="webrtc-remote-pair-key">
              <div className="webrtc-secret-group">
                <Input
                  id="webrtc-remote-pair-key"
                  type={showKey ? 'text' : 'password'}
                  value={pairKey}
                  disabled={phase === 'connecting'}
                  autoComplete="off"
                  placeholder={t('webrtcP2p.pairKeyPlaceholder')}
                  onChange={(event) => {
                    setPairKey(event.target.value)
                    setErrorText('')
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="webrtc-secret-toggle"
                  aria-label={t(showKey ? 'webrtcP2p.hideKey' : 'webrtcP2p.showKey')}
                  onClick={() => setShowKey((prev) => !prev)}
                >
                  <Icon name={showKey ? 'eye-off' : 'eye'} size={16} />
                </Button>
              </div>
            </Field>
            {phase === 'connecting' && (
              <div className="webrtc-pair-status" role="status">
                <Spinner size={14} />
                <span>{t('webrtcP2p.connecting')}</span>
              </div>
            )}
            {errorText && (
              <p className="webrtc-pair-error" role="alert">{errorText}</p>
            )}
            <div className="webrtc-pair-footer">
              <Button
                type="submit"
                variant="primary"
                loading={phase === 'connecting'}
                disabled={(!pairKey.trim() && !sessionAuthorized) || phase === 'connecting'}
              >
                {phase === 'error' ? t('webrtcP2p.retry') : t('webrtcP2p.connect')}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
