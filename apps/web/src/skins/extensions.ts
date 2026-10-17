import * as React from 'react'
import Button from '../components/Button'
import Input from '../components/Input'
import ConfirmDialog from '../components/ConfirmDialog'
import { request } from '../api/transport'
import { executeSkinAction, skinActionEnabled, skinContext, subscribeSkinActions } from './actions'
import type { SkinDocument } from './contract'
import { createFeatureStorage, type FeatureStorage } from './featureStorage'

export type ExtensionSlotName = 'workspace-top' | 'workspace-bottom' | 'workspace-left' | 'workspace-right' | 'chat-header' | 'composer-before' | 'composer-after'
export const extensionSlots: ExtensionSlotName[] = ['workspace-top', 'workspace-bottom', 'workspace-left', 'workspace-right', 'chat-header', 'composer-before', 'composer-after']
export interface FeatureProps { storage: FeatureStorage; close: () => void; onDirtyChange?: (dirty: boolean) => void }
export interface SkinFeature { id: string; title: string; render: React.ComponentType<FeatureProps> }
export interface SkinSlot extends SkinFeature { slot: ExtensionSlotName }
type Snapshot = { features: SkinFeature[]; slots: SkinSlot[] }
export interface ExtensionModule { activate: (api: ExtensionApi) => void | (() => void) | Promise<void | (() => void)> }
export interface ExtensionApi {
  React: typeof React
  components: { Button: typeof Button; Input: typeof Input; ConfirmDialog: typeof ConfirmDialog }
  signal: AbortSignal
  features: { register: (feature: SkinFeature) => () => void }
  slots: { register: (slot: SkinSlot) => () => void }
  actions: { register: (id: string, action: (args?: Record<string, unknown>) => unknown) => () => void; execute: (id: string, args?: Record<string, unknown>) => Promise<unknown>; enabled: (id: string) => boolean }
  context: { get: typeof skinContext; subscribe: typeof subscribeSkinActions }
  client: { request: typeof request }
  storage: (featureId: string) => FeatureStorage
  asset: (path: string) => string
}

export function skinFileUrl(skin: SkinDocument, path: string) {
  if (!/^(?:theme\.(?:js|css)|assets\/[A-Za-z0-9_./-]+)$/.test(path) || path.split('/').some(part => part === '..' || part === '.')) throw new Error('皮肤资源路径无效')
  const [base, query] = (skin.file_base ?? '').split('?')
  if (!base) throw new Error('皮肤资源入口缺失')
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
  readonly skin: SkinDocument
  readonly scope: string
  constructor(skin: SkinDocument, scope: string) { this.skin = skin; this.scope = scope }
  snapshot = () => this.value
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(value: Snapshot) { this.value = value; this.listeners.forEach(listener => listener()) }
  private check() { if (this.controller.signal.aborted) throw new Error('皮肤组件已关闭') }
  storage = (featureId: string) => {
    this.check()
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(featureId)) throw new Error('功能 ID 无效')
    return createFeatureStorage(this.scope, this.skin.manifest.id, featureId)
  }
  enabled = (id: string) => !this.controller.signal.aborted && (this.commands.has(id) || skinActionEnabled(id))
  execute = async (id: string, args?: Record<string, unknown>) => { this.check(); return this.commands.has(id) ? this.commands.get(id)!(args) : executeSkinAction(id, args) }
  private register<T extends SkinFeature>(kind: 'features' | 'slots', feature: T) {
    this.check()
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(feature.id) || typeof feature.title !== 'string' || !feature.title.trim() || typeof feature.render !== 'function' || this.value[kind].some(item => item.id === feature.id)) throw new Error('皮肤组件定义无效或重复')
    if (kind === 'slots' && (!('slot' in feature) || !extensionSlots.includes(feature.slot as ExtensionSlotName))) throw new Error('皮肤插槽不存在')
    this.update({ ...this.value, [kind]: [...this.value[kind], feature] })
    return () => this.update({ ...this.value, [kind]: this.value[kind].filter(item => item !== feature) })
  }
  async activate(loader: (url: string) => Promise<ExtensionModule> = url => import(/* @vite-ignore */ url)) {
    try {
      const module = await loader(skinFileUrl(this.skin, this.skin.script || 'theme.js'))
      if (this.controller.signal.aborted) return
      if (typeof module.activate !== 'function') throw new Error('皮肤组件缺少 activate 入口')
      const cleanup = await module.activate({
        React, components: { Button, Input, ConfirmDialog }, signal: this.controller.signal,
        features: { register: feature => this.register('features', feature) },
        slots: { register: slot => this.register('slots', slot) },
        actions: { register: (id, action) => {
          this.check()
          if (!id || this.commands.has(id)) throw new Error('扩展动作重复或为空')
          this.commands.set(id, action)
          return () => { this.commands.delete(id) }
        }, execute: this.execute, enabled: this.enabled },
        context: { get: skinContext, subscribe: listener => {
          this.check(); const stop = subscribeSkinActions(listener); this.disposers.add(stop)
          return () => { stop(); this.disposers.delete(stop) }
        } },
        client: { request: (path, options) => { this.check(); return request(path, { ...options, signal: options?.signal ?? this.controller.signal }) } },
        storage: this.storage, asset: path => skinFileUrl(this.skin, path),
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
    try { this.cleanup?.() } finally {
      this.disposers.forEach(dispose => dispose()); this.disposers.clear()
      this.commands.clear(); this.update({ features: [], slots: [] })
    }
  }
}
