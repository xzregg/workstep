import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import Button from '../components/Button'
import Field from '../components/Field'
import Icon from '../components/Icon'
import Input from '../components/Input'
import StatusBadge from '../components/StatusBadge'
import { useOverlay } from '../hooks/useOverlay'
import { useVisualViewport } from '../hooks/useVisualViewport'
import { connectWebRtcDirect, fetchWebRtcDeviceConfig, type WebRtcConnectionHandle, type WebRtcStageTiming } from './peerClient'
import { WebRtcConnectionTimings } from './WebRtcConnectionTimings'
import { installGlobalWebRtcTransport, shouldProxyWebRtcHttp } from './transportAdapter'
import { formatLatencyDisplay, useWebRtcConnectionStore } from './webrtcConnectionStore'
import { isWebRtcRemoteBrowser, webrtcDeviceIdFromPath } from './webrtcLocation'
import { consumeWebRtcPairingLink, loadSessionPairKey, saveSessionPairKey, validWebRtcPairKey, PAIR_KEY_MIN_LENGTH, PAIR_KEY_MAX_LENGTH } from './pairingLink'
import '../components/GatewayConnectionStatus.css'
import './WebRtcRemoteFrame.css'
import { initializeAppearancePreferences } from '../utils/appearancePreferences'
import { takeBootstrapConnection, publishDirectConnection } from './bootstrapConnection'

const AUTO_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000] as const
export const WEBRTC_HEARTBEAT_INTERVAL_MS = 10000
export const WEBRTC_NET_CHANGE_PROBE_TIMEOUT_MS = 1500

type NetworkConnectionEventTarget = Navigator & {
  connection?: EventTarget
}

export default function WebRtcRemoteFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const translate = useRef(t)
  useEffect(()=>{translate.current=t},[t])
  const active = isWebRtcRemoteBrowser()
  const deviceId = active ? webrtcDeviceIdFromPath() : ''

  const [deviceName, setDeviceName] = useState(deviceId)
  const [deviceOnline, setDeviceOnline] = useState<boolean | null>(null)
  const [pairKey, setPairKey] = useState(() => { consumeWebRtcPairingLink(); return loadSessionPairKey(deviceId) })
  const [showKey, setShowKey] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
  const [errorText, setErrorText] = useState('')
  const [progress, setProgress] = useState<{ timings: WebRtcStageTiming[]; startedAt: number } | null>(null)
  const [handle, setHandle] = useState<WebRtcConnectionHandle | null>(null)
  const latencyMs = useWebRtcConnectionStore((state) => state.latencyMs)
  const showWorkspace = handle !== null && (phase === 'connected' || phase === 'reconnecting')
  const pairing = active && !showWorkspace
  const pairingDialogRef = useRef<HTMLDivElement>(null)

  const handleRef = useRef<WebRtcConnectionHandle | null>(null)
  const connectAbortRef = useRef<AbortController | null>(null)
  const restoreTransportRef = useRef<(() => void) | null>(null)
  const blobCacheRef = useRef(new Map<string, string>())
  const connectAttemptRef = useRef(0)
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
    handleRef.current?.close()
    handleRef.current = null
  }, [])

  const teardownTransport = useCallback(() => {
    clearReconnectTimer()
    releaseConnection()
    restoreTransportRef.current?.()
    restoreTransportRef.current = null
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

  const cancelPairing = () => {
    manualDisconnectedRef.current = true
    connectAttemptRef.current += 1
    connectAbortRef.current?.abort()
    isConnectingRef.current = false
    setShowKey(false)
    setErrorText('')
    setPhase('idle')
    setProgress(null)
    window.WorkStepP2p?.postMessage('settings')
  }
  useOverlay(pairing, cancelPairing, pairingDialogRef, false, true, pairingDialogRef)
  useVisualViewport(pairing)

  const startConnect = useCallback(async function startConnect(
    secret: string,
    options?: { isAutoReconnect?: boolean },
  ) {
    const trimmed = secret.trim()
    const isAutoReconnect = Boolean(options?.isAutoReconnect)
    if (!deviceId || !validWebRtcPairKey(trimmed)) return

    manualDisconnectedRef.current = false
    clearReconnectTimer()
    if (!isAutoReconnect) {
      autoRetryCountRef.current = 0
    }
    const attempt = ++connectAttemptRef.current
    connectAbortRef.current?.abort()
    const connectionAbort = new AbortController()
    connectAbortRef.current = connectionAbort
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
    let timings: WebRtcStageTiming[] = []
    let stageStartedAt = performance.now()
    const finishStage = (now: number) => {
      const last = timings.at(-1)
      if (last) timings = [...timings.slice(0, -1), { ...last, durationMs: now - stageStartedAt }]
    }

    const scheduleReconnect = () => {
      if (!mountedRef.current || manualDisconnectedRef.current || connectAttemptRef.current !== attempt) return
      const saved = loadSessionPairKey(deviceId)
      const retryIdx = autoRetryCountRef.current
      if (!saved || retryIdx >= AUTO_RECONNECT_DELAYS_MS.length) {
        hasConnectedRef.current = false
        teardownTransport()
        setPhase('error')
        setErrorText(translate.current('webrtcP2p.disconnected'))
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
        void startConnect(saved, { isAutoReconnect: true })
      }, AUTO_RECONNECT_DELAYS_MS[retryIdx])
    }

    try {
      const nextHandle = takeBootstrapConnection(deviceId) ?? await connectWebRtcDirect({
        deviceId, pairKey: trimmed, signal: connectionAbort.signal,
        onDeviceConfig: (config) => {
          if (!mountedRef.current || attempt !== connectAttemptRef.current) return
          setDeviceOnline(config.online)
          if (config.device_name) setDeviceName(config.device_name)
        },
        onStage: (stage) => {
          if (!mountedRef.current || attempt !== connectAttemptRef.current || timings.some(item => item.stage === stage)) return
          const now = performance.now()
          finishStage(now)
          stageStartedAt = now
          timings = [...timings, { stage, durationMs: 0 }]
          setProgress({ timings, startedAt: stageStartedAt })
        },
      })
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
      restoreTransportRef.current?.()
      restoreTransportRef.current = installGlobalWebRtcTransport(nextHandle.transport)
      handleRef.current = nextHandle
      publishDirectConnection(nextHandle)
      setDeviceName(nextHandle.deviceName)
      setDeviceOnline(true)
      setHandle(nextHandle)
      setPhase('connected')
      setProgress(null)
      useWebRtcConnectionStore.setState({
        connected: true,
        reconnecting: false,
        latencyMs: initialLatency,
        deviceName: nextHandle.deviceName,
      })
      if(!isAutoReconnect)void initializeAppearancePreferences()
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
          setErrorText(translate.current('webrtcP2p.relayRejected'))
          return
        }
        releaseConnection()
        scheduleReconnect()
      })
    } catch (err) {
      if (!mountedRef.current || attempt !== connectAttemptRef.current) return
      isConnectingRef.current = false
      const msg = err instanceof Error ? err.message : String(err)
      if (isAutoReconnect && !/relay/i.test(msg) && loadSessionPairKey(deviceId)
        && autoRetryCountRef.current < AUTO_RECONNECT_DELAYS_MS.length) {
        releaseConnection()
        scheduleReconnect()
        return
      }
      hasConnectedRef.current = false
      teardownTransport()
      finishStage(performance.now())
      if (timings.length) setProgress({ timings, startedAt: stageStartedAt })
      setPhase('error')
      setErrorText(/relay/i.test(msg) ? translate.current('webrtcP2p.relayRejected') : msg)
    }
  }, [clearReconnectTimer, deviceId, releaseConnection, teardownTransport])

  useEffect(() => {
    mountedRef.current = true
    if (!active || !deviceId) return
    let mounted = true
    manualDisconnectedRef.current = false
    hasConnectedRef.current = false
    autoRetryCountRef.current = 0
    const configAbort = new AbortController()
    const savedKey = loadSessionPairKey(deviceId)
    if (savedKey) {
      void startConnect(savedKey)
    } else void fetchWebRtcDeviceConfig(deviceId, configAbort.signal).then((cfg) => {
      if (!mounted) return
      setDeviceOnline(cfg.online)
      if (cfg.device_name) setDeviceName(cfg.device_name)
    }).catch(() => undefined)

    return () => {
      mounted = false
      configAbort.abort()
      mountedRef.current = false
      isConnectingRef.current = false
      connectAttemptRef.current += 1
      connectAbortRef.current?.abort()
      teardownTransport()
    }
  }, [active, deviceId, startConnect, teardownTransport])

  const runPingProbe = useCallback(async (timeoutMs: number, networkChange: boolean) => {
    const current = handleRef.current
    if (!current || !current.transport.isOpen || isConnectingRef.current || manualDisconnectedRef.current) {
      return
    }
    if (!networkChange && netProbeInFlightRef.current) return
    const lockRef = networkChange ? netProbeInFlightRef : periodicProbeInFlightRef
    if (lockRef.current) return
    lockRef.current = true
    try {
      const measuredMs = await current.transport.ping(timeoutMs).catch((error: unknown) => {
        if (!networkChange || handleRef.current !== current || !current.transport.isOpen) throw error
        return current.transport.ping(timeoutMs)
      })
      if (!mountedRef.current || handleRef.current !== current) return
      missedPingsRef.current = 0
      useWebRtcConnectionStore.setState((prev) => (prev.connected ? { latencyMs: measuredMs } : prev))
    } catch {
      if (!mountedRef.current || handleRef.current !== current || manualDisconnectedRef.current) return
      if (!networkChange && netProbeInFlightRef.current) return
      missedPingsRef.current += 1
      if (networkChange || missedPingsRef.current >= 2) {
        missedPingsRef.current = 0
        const saved = loadSessionPairKey(deviceId)
        if (saved) {
          void startConnect(saved, {
            isAutoReconnect: true,
          })
        }
      }
    } finally {
      if (handleRef.current === current) lockRef.current = false
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
      if (!saved) return
      if (isConnectingRef.current && reconnectTimerRef.current === null) return
      const current = handleRef.current
      if (
        !current
        || !current.transport.isOpen
        || current.peerConnection.iceConnectionState === 'failed'
        || current.peerConnection.iceConnectionState === 'closed'
      ) {
        void startConnect(saved, {
          isAutoReconnect: hasConnectedRef.current,
        })
        return
      }
      if (!isNetworkEvent && Date.now() - connectedAtRef.current < 500) {
        return
      }
      void runPingProbe(isNetworkEvent ? WEBRTC_NET_CHANGE_PROBE_TIMEOUT_MS : 3000, isNetworkEvent)
    }
    const onNetworkChange = () => triggerRecover(true)
    const onTransferDisconnect = () => {
      if (manualDisconnectedRef.current || isConnectingRef.current) return
      const saved = loadSessionPairKey(deviceId)
      if (saved) void startConnect(saved, { isAutoReconnect: true })
    }
    const onResume = () => triggerRecover(false)
    const onVisible = () => {
      if (document.visibilityState === 'visible') onResume()
    }
    const connection = (navigator as NetworkConnectionEventTarget).connection
    window.addEventListener('online', onNetworkChange)
    window.addEventListener('workstep:webrtc-reconnect', onTransferDisconnect)
    window.addEventListener('workstep:resume', onResume)
    document.addEventListener('visibilitychange', onVisible)
    connection?.addEventListener?.('change', onNetworkChange)
    return () => {
      window.removeEventListener('online', onNetworkChange)
      window.removeEventListener('workstep:webrtc-reconnect', onTransferDisconnect)
      window.removeEventListener('workstep:resume', onResume)
      document.removeEventListener('visibilitychange', onVisible)
      connection?.removeEventListener?.('change', onNetworkChange)
    }
  }, [active, deviceId, runPingProbe, startConnect])

  // Rewrite same-origin media `src` elements inside the connected workspace to Blob URLs fetched over DataChannel.
  useEffect(() => {
    if (!active || phase !== 'connected' || !handle || typeof MutationObserver === 'undefined') return
    const MEDIA_SELECTOR = 'img[src], audio[src], video[src], source[src]'
    const pending = new Map<string, Promise<string | undefined>>()
    const abort = new AbortController()
    const rewriteMedia = (el: HTMLElement) => {
      if (!(el instanceof HTMLImageElement || el instanceof HTMLAudioElement || el instanceof HTMLVideoElement || el instanceof HTMLSourceElement)) {
        return
      }
      const rawSrc = (el.getAttribute('src') || '').trim()
      if (!rawSrc || rawSrc.startsWith('blob:') || rawSrc.startsWith('data:') || !shouldProxyWebRtcHttp(rawSrc)) {
        return
      }
      const requestUrl = new URL(rawSrc, window.location.href).href
      const cached = blobCacheRef.current.get(requestUrl)
      if (cached) {
        el.src = cached
        return
      }
      let load = pending.get(requestUrl)
      if (!load) {
        load = handle.transport.fetch(requestUrl, { signal: abort.signal }).then(async (res) => {
          if (!res.ok) return
          const blob = await res.blob()
          if (abort.signal.aborted) return
          const url = URL.createObjectURL(blob)
          blobCacheRef.current.set(requestUrl, url)
          return url
        }).catch(() => undefined).finally(() => pending.delete(requestUrl))
        pending.set(requestUrl, load)
      }
      void load.then(url => {
        if (url && !abort.signal.aborted && (el.getAttribute('src') || '').trim() === rawSrc) {
          el.src = url
        }
      })
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
    return () => {
      observer.disconnect()
      abort.abort()
    }
  }, [active, handle, phase])

  if (!active) return <>{children}</>

  if (showWorkspace) {
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
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void startConnect(loadSessionPairKey(deviceId) || pairKey, {})}
            >
              <Icon name="refresh" size={14} />
              {t('webrtcP2p.reconnect')}
            </Button>
            <Button
              type="button"
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
    <div className="modal-overlay webrtc-pair-overlay">
      <div ref={pairingDialogRef} tabIndex={-1} className="modal webrtc-pair-card" role="dialog" aria-modal="true" aria-label={t('webrtcP2p.connectTitle')}>
        <div className="modal-header">
          <span className="modal-title">{deviceName || t('webrtcP2p.connectTitle')}</span>
          {deviceOnline === false && <StatusBadge status="failed" label={t('webrtcP2p.deviceOffline')} />}
        </div>
        <div className="modal-body">
          <form
            className="webrtc-pair-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (validWebRtcPairKey(pairKey.trim()) && phase !== 'connecting') {
                void startConnect(pairKey, {})
              }
            }}
          >
            <Field label={t('webrtcP2p.pairKey')} htmlFor="webrtc-remote-pair-key"
              error={pairKey && !validWebRtcPairKey(pairKey.trim()) ? t('webrtcP2p.pairKeyLength') : undefined}>
              <div className="webrtc-secret-group">
                <Input
                  id="webrtc-remote-pair-key"
                  type={showKey ? 'text' : 'password'}
                  value={pairKey}
                  disabled={phase === 'connecting'}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  minLength={PAIR_KEY_MIN_LENGTH}
                  maxLength={PAIR_KEY_MAX_LENGTH}
                  pattern="[A-Za-z0-9_\-]{24,128}"
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
            {progress && <WebRtcConnectionTimings timings={progress.timings} startedAt={progress.startedAt} failed={phase === 'error'} />}
            {errorText && (
              <p className="webrtc-pair-error" role="alert">{errorText}</p>
            )}
            <div className="webrtc-pair-footer">
              {(window.WorkStepP2p || phase === 'connecting') && (
                <Button type="button" variant="ghost" onClick={cancelPairing}>{t('common.cancel')}</Button>
              )}
              <Button
                type="submit"
                variant="primary"
                loading={phase === 'connecting'}
                disabled={!validWebRtcPairKey(pairKey.trim()) || phase === 'connecting'}
              >
                {phase === 'connecting' ? <span role="status">{t('webrtcP2p.connecting')}</span>
                  : phase === 'error' ? t('webrtcP2p.retry') : t('webrtcP2p.connect')}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
