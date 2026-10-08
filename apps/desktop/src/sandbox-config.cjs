const fs = require('node:fs/promises')
const path = require('node:path')

const PROVIDER_FIELDS = ['id', 'name', 'type', 'protocol', 'protocols', 'base_url', 'protocol_base_urls', 'api_key', 'enabled']
const ENGINE_FIELDS = ['engine', 'provider_id', 'model', 'fast_model', 'vision_model', 'thinking_effort', 'model_reasoning_effort', 'approval_policy', 'approval_mode', 'permission_mode', 'sandbox', 'sandbox_mode', 'harness', 'preset', 'max_tokens', 'max_turns', 'fallback_model', 'model_map', 'include_partial_messages', 'allowed_tools', 'personal_access_token']
const ENGINE_SECTIONS = ['pydantic_ai_engine', 'deepseek_harness_engine', 'claude_code_engine', 'claude_agent_sdk_engine', 'codex_engine', 'codex_sdk_engine', 'qoder_sdk_engine', 'opencode_engine']
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const pick = (value, fields) => Object.fromEntries(fields.filter(key => object(value) && Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]))
const hostPath = value => typeof value === 'string' && /^(?:\/(?!\/)|[A-Za-z]:[\\/]|~[\\/]|file:)/.test(value)
function merge(target, incoming, overwrite) {
  const result = structuredClone(target)
  for (const [key, value] of Object.entries(incoming)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
    if (object(result[key]) && object(value)) result[key] = merge(result[key], value, overwrite)
    else if (overwrite || !Object.hasOwn(result, key)) result[key] = structuredClone(value)
  }
  return result
}
function localProviderWarnings(config) {
  const warnings = []
  for (const item of Array.isArray(config.providers) ? config.providers : []) {
    const urls = [item.base_url, ...Object.values(object(item.protocol_base_urls) ? item.protocol_base_urls : {})]
    if (urls.some(value => { try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(value).hostname) } catch { return false } })) warnings.push(String(item.name || item.id))
  }
  return warnings
}
function migrateConfig(source, target, options) {
  const config = structuredClone(target), ids = new Map()
  if (options.providers) {
    const providers = Array.isArray(config.providers) ? structuredClone(config.providers) : []
    for (const raw of Array.isArray(source.providers) ? source.providers : []) {
      if (!object(raw) || !raw.id || raw.managed) continue
      const item = pick(raw, PROVIDER_FIELDS)
      const existing = providers.findIndex(p => p.id === item.id || (item.name && p.name === item.name))
      if (existing >= 0) {
        ids.set(item.id, providers[existing].id)
        if (options.overwrite && !providers[existing].managed) providers[existing] = { ...item, id: providers[existing].id }
      } else { ids.set(item.id, item.id); providers.push(item) }
    }
    config.providers = providers
  }
  for (const item of Array.isArray(config.providers) ? config.providers : []) ids.set(item.id, item.id)
  function binding(value) {
    const result = pick(value, ENGINE_FIELDS)
    for (const key of ['model', 'fast_model', 'vision_model', 'fallback_model']) if (hostPath(result[key])) delete result[key]
    if (object(result.model_map)) result.model_map = Object.fromEntries(Object.entries(result.model_map).filter(([, value]) => typeof value === 'string' && !hostPath(value)))
    if (result.provider_id) {
      const mapped = ids.get(result.provider_id)
      if (mapped) result.provider_id = mapped
      else delete result.provider_id
    }
    return result
  }
  if (options.engines) {
    const incoming = pick(source, ['execution_default_engine', 'engine_default_models', 'claude_permission_mode', 'engine_idle_timeout_seconds', 'coordinator_default_engine', 'coordinator_default_model', 'coordinator_default_fast_model', 'coordinator_default_vision_model', 'coordinator_default_thinking_effort'])
    if (object(incoming.engine_default_models)) incoming.engine_default_models = Object.fromEntries(Object.entries(incoming.engine_default_models).filter(([, value]) => typeof value === 'string' && !hostPath(value)))
    for (const key of ['coordinator_default_model', 'coordinator_default_fast_model', 'coordinator_default_vision_model']) if (hostPath(incoming[key])) delete incoming[key]
    if (object(source.engine_providers)) incoming.engine_providers = Object.fromEntries(Object.entries(source.engine_providers).filter(([, id]) => ids.has(id)).map(([engine, id]) => [engine, ids.get(id)]))
    for (const key of ENGINE_SECTIONS) if (object(source[key])) incoming[key] = binding(source[key])
    if (object(source.assistant_defaults)) incoming.assistant_defaults = Object.fromEntries(Object.entries(source.assistant_defaults).map(([key, value]) => [key, pick(binding(value), ['engine', 'model', 'fast_model', 'vision_model', 'thinking_effort', 'provider_id'])]))
    Object.assign(config, merge(config, incoming, options.overwrite))
  }
  if (options.providers && object(source.provider_models)) {
    const cache = {}
    for (const [key, entry] of Object.entries(source.provider_models)) {
      const [provider, protocol] = key.split('::')
      if (!ids.has(provider) || !object(entry) || !Array.isArray(entry.models)) continue
      const models = entry.models.filter(object).map(model => pick(model, ['id', 'name', 'context_window', 'max_output_tokens', 'input_cost', 'output_cost'])).filter(model => typeof model.id === 'string' && !hostPath(model.id))
      const mapped = ids.get(provider) + (protocol ? `::${protocol}` : '')
      cache[mapped] = { models, fetched_at: typeof entry.fetched_at === 'string' ? entry.fetched_at : '' }
    }
    config.provider_models = merge(object(config.provider_models) ? config.provider_models : {}, cache, options.overwrite)
  }
  if (options.preferences) {
    const incoming = pick(source, ['git_scan_depth'])
    if (object(source.user)) incoming.user = pick(source.user, ['name'])
    if (object(source.concurrency)) incoming.concurrency = pick(source.concurrency, ['max_tasks', 'max_chats', 'schedule_exempt'])
    if (object(source.remote_access)) incoming.remote_access = pick(source.remote_access, [
      'enabled', 'external_base_url', 'host_id', 'access_password_salt',
      'access_password_hash', 'access_password_set_at',
    ])
    Object.assign(config, merge(config, incoming, options.overwrite))
  }
  const warnings = options.providers ? localProviderWarnings(config) : []
  return { config, warnings }
}
async function readConfig(file) {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('配置文件无效')
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!object(value)) throw new Error('配置格式无效')
    return value
  } catch (error) { if (error.code === 'ENOENT') return {}; if (error instanceof SyntaxError) throw new Error('配置文件无法解析，请检查原配置文件'); throw error }
}
function projectCatalog(config) {
  return (Array.isArray(config.projects) ? config.projects : []).flatMap(item => {
    const entry = typeof item === 'string' ? { path: item, name: path.basename(item) } : item
    return object(entry) && typeof entry.path === 'string' && path.isAbsolute(entry.path)
      ? [{ path: entry.path, name: String(entry.name || path.basename(entry.path)), ...(typeof entry.id === 'string' ? { id: entry.id } : {}) }] : []
  })
}
async function mapProjects(config, catalog, selected) {
  if (!Array.isArray(selected) || selected.length > 32 || selected.some(value => typeof value !== 'string')) throw new Error('项目关联配置无效')
  const mounts = await Promise.all([{ source: config.project, target: '/data/projects' }, ...config.mounts].map(async item => ({ ...item, source: await fs.realpath(item.source) })))
  const entries = []
  for (const source of new Set(selected)) {
    const resolved = await fs.realpath(source)
    const match = mounts.filter(mount => { const relative = path.relative(mount.source, resolved); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) }).sort((a, b) => b.source.length - a.source.length)[0]
    if (!match) throw new Error('关联项目必须位于已授权的项目挂载内')
    const db = await fs.lstat(path.join(resolved, '.workstep/workstep.db')).catch(error => { if (error.code === 'ENOENT') throw new Error('请选择已有 WorkStep 项目；空目录请使用新的项目目录选项'); throw error })
    if (!db.isFile() || db.isSymbolicLink()) throw new Error('请选择已有 WorkStep 项目')
    const original = catalog.find(item => path.resolve(item.path) === path.resolve(source))
    const relative = path.relative(match.source, resolved).split(path.sep).join('/')
    entries.push({ path: path.posix.join(match.target, relative), ...(original?.id ? { id: original.id } : {}), name: original?.name || path.basename(resolved), sort_order: entries.length })
  }
  return entries
}

module.exports = { migrateConfig, readConfig, projectCatalog, mapProjects, localProviderWarnings }
