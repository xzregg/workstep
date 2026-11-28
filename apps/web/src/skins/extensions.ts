import * as React from 'react'
import Button from '../components/Button'
import Input from '../components/Input'
import ConfirmDialog from '../components/ConfirmDialog'
import {getAvatarState,subscribeAvatar,type AvatarSnapshot,type AvatarScope,type AvatarEvent} from '../avatars/runtime'
import * as avatarMotion from '../avatars/motion'
import { request } from '../api/transport'
import { executeSkinAction, skinActionEnabled, skinContext, subscribeSkinActions } from './actions'
import type { SkinDocument } from './contract'
import { createFeatureStorage, type FeatureStorage } from './featureStorage'
import { isWebRtcRemoteBrowser } from '../webrtc/webrtcLocation'
import { SkinResources } from './resources'

export type ExtensionSlotName = 'workspace-top' | 'workspace-bottom' | 'workspace-left' | 'workspace-right' | 'chat-header' | 'composer-before' | 'composer-after'
export const extensionSlots: ExtensionSlotName[] = ['workspace-top', 'workspace-bottom', 'workspace-left', 'workspace-right', 'chat-header', 'composer-before', 'composer-after']
export interface FeatureProps { storage: FeatureStorage; close: () => void; onDirtyChange?: (dirty: boolean) => void }
export interface SkinFeature { id: string; title: string; render: React.ComponentType<FeatureProps> }
export interface SkinSlot extends SkinFeature { slot: ExtensionSlotName }
export interface AvatarRenderProps {state:AvatarSnapshot;name:string}
export interface SkinAvatar {id:string;render:React.ComponentType<AvatarRenderProps>}
type Snapshot = { features: SkinFeature[]; slots: SkinSlot[]; avatar?:SkinAvatar }
export interface ExtensionModule { activate?: (api: ExtensionApi) => void | (() => void) | Promise<void | (() => void)> }
export interface ExtensionApi {
  React: typeof React
  components: { Button: typeof Button; Input: typeof Input; ConfirmDialog: typeof ConfirmDialog }
  signal: AbortSignal
  features: { register: (feature: SkinFeature) => () => void }
  slots: { register: (slot: SkinSlot) => () => void }
  actions: { register: (id: string, action: (args?: Record<string, unknown>) => unknown) => () => void; execute: (id: string, args?: Record<string, unknown>) => Promise<unknown>; enabled: (id: string) => boolean }
  context: { get: typeof skinContext; subscribe: typeof subscribeSkinActions }
  avatar: {get:(scope?:AvatarScope)=>AvatarSnapshot|null;subscribe:(listener:(event:AvatarEvent)=>void,scope?:AvatarScope)=>()=>void;register:(avatar:SkinAvatar)=>()=>void;motion:typeof avatarMotion}
  client: { request: typeof request }
  storage: (featureId: string) => FeatureStorage
  asset: (path: string) => string
}

export function skinFileUrl(skin: SkinDocument, path: string) {
  if (!/^(?:theme\.(?:js|css)|assets\/[A-Za-z0-9_./-]+)$/.test(path) || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid skin resource path')
  const [base, query] = (skin.file_base ?? '').split('?')
  if (!base) throw new Error('Missing skin resource entry')
  return `${base}/${path}${query ? '?' + query : ''}`
}

/** One activation owns its contributions; a disposed generation can never publish late results. */
export class ExtensionSession {
  private value: Snapshot = { features: [], slots: [] }
  private listeners = new Set<() => void>()
  private commands = new Map<string, (args?: Record<string, unknown>) => unknown>()
  private controller = new AbortController()
  private cleanup?: () => void
  private disposers = new Set<() => void>()
  private resources = new SkinResources()
  readonly skin: SkinDocument
  readonly scope: string
  constructor(skin: SkinDocument, scope: string) { this.skin = skin; this.scope = scope }
  snapshot = () => this.value
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(value: Snapshot) { this.value = value; this.listeners.forEach(listener => listener()) }
  private check() { if (this.controller.signal.aborted) throw new Error('The skin component is disabled') }
  storage = (featureId: string) => {
    this.check()
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(featureId)) throw new Error('Invalid function ID')
    return createFeatureStorage(this.scope, this.skin.manifest.id, featureId)
  }
  enabled = (id: string) => !this.controller.signal.aborted && (this.commands.has(id) || skinActionEnabled(id))
  execute = async (id: string, args?: Record<string, unknown>) => { this.check(); return this.commands.has(id) ? this.commands.get(id)!(args) : executeSkinAction(id, args) }
  private register<T extends SkinFeature>(kind: 'features' | 'slots', feature: T) {
    this.check()
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(feature.id) || typeof feature.title !== 'string' || !feature.title.trim() || typeof feature.render !== 'function' || this.value[kind].some(item => item.id === feature.id)) throw new Error('Invalid or duplicate skin component definition')
    if (kind === 'slots' && (!('slot' in feature) || !extensionSlots.includes(feature.slot as ExtensionSlotName))) throw new Error('Skin slot does not exist')
    this.update({ ...this.value, [kind]: [...this.value[kind], feature] })
    return () => this.update({ ...this.value, [kind]: this.value[kind].filter(item => item !== feature) })
  }
  private registerAvatar(avatar:SkinAvatar) {
    this.check()
    if(!/^[a-z][a-z0-9_-]{0,63}$/.test(avatar.id)||typeof avatar.render!=='function'||this.value.avatar)throw new Error('Invalid or duplicate skin appearance definition')
    this.update({...this.value,avatar})
    return()=>{if(this.value.avatar!==avatar)return;const value={...this.value};delete value.avatar;this.update(value)}
  }
  async activate(loader?: (url: string) => Promise<ExtensionModule>) {
    try {
      const sourceUrl = skinFileUrl(this.skin, this.skin.script || 'theme.js')
      let module: ExtensionModule
      if (!loader && isWebRtcRemoteBrowser()) {
        const moduleUrl = await this.resources.load(sourceUrl)
        for (const path of this.skin.resource_paths ?? []) {
          await this.resources.load(skinFileUrl(this.skin, path))
        }
        if (this.controller.signal.aborted) return
        module = await import(/* @vite-ignore */ moduleUrl) as ExtensionModule
      } else {
        module = await (loader ?? (url => import(/* @vite-ignore */ url)))(sourceUrl)
      }
      if (this.controller.signal.aborted) return
      // An empty theme.js is a valid placeholder for skins without custom behavior.
      if (Object.keys(module).length === 0) return
      if (typeof module.activate !== 'function') throw new Error('The skin component is missing the activate entry')
      const cleanup = await module.activate({
        React, components: { Button, Input, ConfirmDialog }, signal: this.controller.signal,
        features: { register: feature => this.register('features', feature) },
        slots: { register: slot => this.register('slots', slot) },
        actions: { register: (id, action) => {
          this.check()
          if (!id || this.commands.has(id)) throw new Error('Extended action is duplicated or empty')
          this.commands.set(id, action)
          return () => { this.commands.delete(id) }
        }, execute: this.execute, enabled: this.enabled },
        context: { get: skinContext, subscribe: listener => {
          this.check(); const stop = subscribeSkinActions(listener); this.disposers.add(stop)
          return () => { stop(); this.disposers.delete(stop) }
        } },
        avatar: {
          get: scope=>{this.check();return getAvatarState(scope)},
          subscribe:(listener,scope)=>{
            this.check();const stop=subscribeAvatar(listener,scope);this.disposers.add(stop)
            return()=>{stop();this.disposers.delete(stop)}
          },
          register: avatar=>this.registerAvatar(avatar),motion:avatarMotion,
        },
        client: { request: (path, options) => { this.check(); return request(path, { ...options, signal: options?.signal ?? this.controller.signal }) } },
        storage: this.storage, asset: path => this.resources.get(skinFileUrl(this.skin, path)),
      })
      if (typeof cleanup === 'function') {
        if (this.controller.signal.aborted) cleanup()
        else this.cleanup = cleanup
      }
    } catch (error) { this.dispose(); throw error }
  }
  dispose() {
    if (this.controller.signal.aborted) return
    this.controller.abort()
    this.resources.dispose()
    try { this.cleanup?.() } finally {
      this.disposers.forEach(dispose => dispose()); this.disposers.clear()
      this.commands.clear(); this.update({ features: [], slots: [] })
    }
  }
}
