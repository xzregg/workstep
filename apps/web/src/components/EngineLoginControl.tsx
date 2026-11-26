import { useEffect, useRef, useState } from 'react'
import { engineApi, type EngineLoginState } from '../api/engine'
import { useI18n } from '../i18n'
import Button, { ButtonLink } from './Button'
import Input from './Input'
import Spinner from './Spinner'
import './EngineLoginControl.css'

const pending = (state: EngineLoginState | null) => !!state && ['starting', 'waiting_code', 'submitting'].includes(state.phase)

export default function EngineLoginControl({ engineId, active, onAuthenticated }: {
  engineId: string
  active: boolean
  onAuthenticated: () => void | Promise<void>
}) {
  const { t } = useI18n()
  const [state, setState] = useState<EngineLoginState | null>(null)
  const [code, setCode] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const mounted = useRef(true)
  const notified = useRef('')
  const changed = useRef(onAuthenticated)
  changed.current = onAuthenticated

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])

  useEffect(() => {
    if (!active) setCode('')
  }, [active])

  const receive = (next: EngineLoginState | null) => {
    setState(next)
    if (next?.phase !== 'waiting_code') setCode('')
    if (next?.phase === 'succeeded' && notified.current !== next.id) {
      notified.current = next.id
      void Promise.resolve(changed.current()).catch(() => {})
    }
  }

  useEffect(() => {
    if (!active || busy) return
    const version = ++generation.current
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await engineApi.loginStatus(engineId)
        if (disposed || generation.current !== version) return
        receive(next)
        setReady(true)
        setError('')
        if (pending(next)) timer = setTimeout(() => void poll(), 1000)
      } catch (cause) {
        if (!disposed && generation.current === version) setError(cause instanceof Error ? cause.message : t('engineLogin.readFailed'))
      }
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [active, busy, engineId, revision])

  const run = async (action: 'start' | 'submit' | 'cancel') => {
    if (busy) return
    generation.current++
    setBusy(true)
    setError('')
    const value = code.trim()
    setCode('')
    try {
      const next = action === 'start' ? await engineApi.startLogin(engineId)
        : action === 'cancel' ? await engineApi.cancelLogin(engineId, state!.id)
          : await engineApi.submitLoginCode(engineId, state!.id, value)
      if (!mounted.current) return
      receive(next)
      setReady(true)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('engineLogin.failed'))
    } finally {
      if (mounted.current) { setBusy(false); setRevision(value => value + 1) }
    }
  }

  const running = pending(state)
  const spinning = state?.phase === 'starting' || state?.phase === 'submitting'
  const status = state?.phase === 'starting' ? t('engineLogin.starting')
    : state?.phase === 'waiting_code' ? t('engineLogin.waiting')
      : state?.phase === 'submitting' ? t('engineLogin.submitting')
        : state?.phase === 'succeeded' ? t('engineLogin.succeeded')
          : state?.phase === 'cancelled' ? t('engineLogin.cancelled') : ''
  return <section className="engine-login-control" aria-label={t('engineLogin.title')}>
    <div className="engine-login-heading">
      <span className="engine-login-title">{t('engineLogin.title')}</span>
      {!running && ready && <Button disabled={busy} loading={busy} onClick={() => void run('start')}>
        {t(state?.phase === 'succeeded' ? 'engineLogin.again' : 'engineLogin.start')}
      </Button>}
      {running && <Button disabled={busy} loading={busy} onClick={() => void run('cancel')}>{t('engineLogin.cancel')}</Button>}
    </div>
    {!ready && !error && <div role="status"><Spinner /> {t('engineLogin.loading')}</div>}
    {status && <div className="engine-login-status" role="status">{spinning && <Spinner />}{status}</div>}
    {state?.phase === 'waiting_code' && <form className="engine-login-form" onSubmit={event => { event.preventDefault(); if (code.trim() && !busy) void run('submit') }}>
      {state.authorization_url && <ButtonLink href={state.authorization_url} target="_blank" rel="noopener noreferrer">{t('engineLogin.openBrowser')}</ButtonLink>}
      <label htmlFor={`login-code-${engineId}`}>{t('engineLogin.code')}</label>
      <Input id={`login-code-${engineId}`} type="password" autoComplete="off" spellCheck={false}
        value={code} disabled={busy} maxLength={8192} placeholder={t('engineLogin.codePlaceholder')}
        onChange={event => setCode(event.target.value)} />
      <Button type="submit" variant="primary" disabled={!code.trim() || busy} loading={busy}>{t('engineLogin.submit')}</Button>
    </form>}
    {state?.phase === 'failed' && <div role="alert">{t(state.error === 'login_timeout' ? 'engineLogin.timeout' : 'engineLogin.failed')}</div>}
    {error && <div className="engine-login-error" role="alert">{error}{' '}
      <Button disabled={busy} onClick={() => { setError(''); setRevision(value => value + 1) }}>{t('common.retry')}</Button>
    </div>}
  </section>
}
