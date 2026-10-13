import { useCallback, useEffect, useRef, useState } from 'react'
import { languagesApi } from '../api/languages'
import { ApiError } from '../api/transport'
import { useI18n, useLocaleStore, createLanguageT } from '../i18n'
import { languageCatalog, validateLanguage, type LanguageDocument } from '../i18n/languagePack'
import Button from './Button'
import Input from './Input'
import ConfirmDialog from './ConfirmDialog'
import './LanguageDraftPanel.css'

export default function LanguageDraftPanel({workspacePath, running}: {workspacePath: string; running: boolean}) {
 const {t}=useI18n()
 const installed=useLocaleStore(s => s.installed)
 const [path, setPath]=useState(workspacePath + '/language')
 const [input, setInput]=useState(path)
 const [document, setDocument]=useState<LanguageDocument | null>(null)
 const [error, setError]=useState('')
 const [busy, setBusy]=useState(false)
 const [replace, setReplace]=useState(false)
 const [importing, setImporting]=useState<File | null>(null)
 const [removing, setRemoving]=useState<string | null>(null)
 const mounted=useRef(false), generation=useRef(0)
 const fileInput=useRef<HTMLInputElement>(null)
 const inFlight=useRef<{path:string; promise:Promise<void>} | null>(null)
 const load=useCallback(() => {
  if (inFlight.current?.path === path) return inFlight.current.promise
  const current=++generation.current
  const promise=languagesApi.validate(path).then(result => {
   const pack=validateLanguage(result.package)
   if (mounted.current && current === generation.current) { setDocument(pack); setError('') }
  }).catch(reason => {
   if (!mounted.current || current !== generation.current) return
   setDocument(null)
   setError(reason instanceof ApiError && reason.status === 404 ? '' : String(reason.message || reason))
  }).finally(() => { if (inFlight.current?.promise === promise) inFlight.current=null })
  inFlight.current={path,promise}; return promise
 }, [path])
 useEffect(() => { mounted.current=true; return () => { mounted.current=false; ++generation.current; inFlight.current=null } }, [])
 useEffect(() => { if (!running) void load() }, [running, load])
 const run=async (action:() => Promise<void>) => {
  if (busy || running) return
  setBusy(true); setError('')
  try { await action() } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
  finally { if (mounted.current) setBusy(false) }
 }
 const install=async (overwrite=false) => {
  try {
   const pack=validateLanguage(await languagesApi.register(path, overwrite))
   if (!mounted.current) return
   setDocument(pack); setReplace(false)
   useLocaleStore.getState().previewLanguage(pack)
   await useLocaleStore.getState().refresh()
  } catch (reason) {
   if (reason instanceof ApiError && reason.status === 409) setReplace(true)
   else throw reason
  }
 }
 const importFile=async (file:File, overwrite=false) => {
  try {
   const pack=validateLanguage(await languagesApi.import(file, overwrite))
   if (!mounted.current) return
   setImporting(null); useLocaleStore.getState().previewLanguage(pack); await useLocaleStore.getState().refresh()
  } catch (reason) {
   if (reason instanceof ApiError && reason.status === 409) setImporting(file)
   else throw reason
  }
 }
 const previewT=document ? createLanguageT(document) : null
 return <section className="language-draft-panel" aria-label={t('languages.title')}>
  <p className="skin-studio-note">{t('languages.hint')}</p>
  <label>{t('languages.path')}<Input aria-label={t('languages.path')} value={input} disabled={busy || running} onChange={event => setInput(event.target.value)} /></label>
  <Button size="sm" disabled={!input.trim() || busy || running} loading={busy} onClick={() => void run(async () => { if (path === input.trim()) await load(); else { setDocument(null); setPath(input.trim()) } })}>{t('languages.read')}</Button>
  {error && <p className="skin-studio-error" role="alert">{error}</p>}
  {!document ? <p className="skin-studio-note">{t('languages.waiting')}</p> : <>
   <h4>{document.manifest.native_name} · {document.manifest.locale}</h4>
   <p>{document.manifest.name} · {document.manifest.version}</p>
   <p role="status">{t('languages.coverage', {translated:Object.keys(document.messages).length, total:Object.keys(languageCatalog.messages).length, fallback:document.manifest.fallback_locale})}</p>
   {document.manifest.catalog_revision !== languageCatalog.revision && <p className="skin-studio-note">{t('languages.catalogOld')}</p>}
   <details><summary>{t('languages.missing')}</summary><pre>{Object.keys(languageCatalog.messages).filter(key => !Object.hasOwn(document.messages,key)).join('\n')}</pre></details>
   <div className="language-draft-samples"><strong>{t('languages.samples')}</strong>{(['nav.settings','common.save','common.cancel','interaction.allow','interaction.deny'] as const).map(key => <p key={key}><code>{key}</code><span>{previewT!(key)}</span></p>)}</div>
   <div className="skin-settings-actions"><Button disabled={busy || running} onClick={() => useLocaleStore.getState().previewLanguage(document)}>{t('languages.preview')}</Button><Button variant="primary" disabled={busy || running} loading={busy} onClick={() => void run(() => install())}>{t('languages.install')}</Button></div>
  </>}
  <input ref={fileInput} type="file" accept=".zip,application/zip" className="skin-settings-file" onChange={event => { const file=event.target.files?.[0]; event.target.value=''; if (file) void run(() => importFile(file)) }} />
  <Button size="sm" disabled={busy || running} onClick={() => fileInput.current?.click()}>{t('languages.import')}</Button>
  {!!installed.length && <details><summary>{t('languages.installed')}</summary>{installed.map(item => <div key={item.manifest.id} className="language-draft-installed"><span>{item.manifest.native_name}</span><Button size="sm" disabled={busy || running} onClick={() => void run(async () => {
   const blob=await languagesApi.export(item.manifest.id), url=URL.createObjectURL(blob)
   try { const link=window.document.createElement('a'); link.href=url; link.download=item.manifest.id + '.zip'; link.click() } finally { window.setTimeout(() => URL.revokeObjectURL(url),0) }
  })}>{t('languages.export')}</Button><Button size="sm" disabled={busy || running} onClick={() => setRemoving(item.manifest.id)}>{t('languages.remove')}</Button></div>)}</details>}
  <ConfirmDialog open={replace || !!importing} title={t('languages.replace')} loading={busy} onCancel={() => { if (!busy) { setReplace(false); setImporting(null) } }} onConfirm={() => void run(() => importing ? importFile(importing,true) : install(true))} />
  <ConfirmDialog open={!!removing} title={t('languages.removeConfirm')} loading={busy} onCancel={() => { if (!busy) setRemoving(null) }} onConfirm={() => void run(async () => { const id=removing!; await languagesApi.remove(id); if (useLocaleStore.getState().language?.manifest.id === id) useLocaleStore.getState().setLocale(useLocaleStore.getState().language!.manifest.fallback_locale); await useLocaleStore.getState().refresh(); if (mounted.current) setRemoving(null) })} />
 </section>
}
