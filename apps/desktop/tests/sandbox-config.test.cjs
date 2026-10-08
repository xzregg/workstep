const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { migrateConfig, mapProjects, localProviderWarnings } = require('../src/sandbox-config.cjs')

test('local provider warnings reflect the providers currently present', () => {
  assert.deepEqual(localProviderWarnings({ providers: [
    { name: 'Local', base_url: 'http://localhost:12345/v1' },
    { name: 'Remote', base_url: 'https://example.com/v1' },
  ] }), ['Local'])
  assert.deepEqual(localProviderWarnings({ providers: [] }), [])
})

test('migration keeps supplier secrets and bindings together, excludes paths and protects target settings', () => {
  const source = {
    providers: [{ id: 'one', name: 'Local', api_key: 'test-secret', base_url: 'http://127.0.0.1:8000/v1', custom_path: '/host/secret' }, { id: 'managed', managed: true }],
    engine_providers: { pydantic_ai: 'one', codex_sdk: 'managed' },
    pydantic_ai_engine: { provider_id: 'one', model: 'test-model', mcp_servers: [{ command: '/host/tool' }] },
    codex_engine: { approval_policy: 'on-request', custom_config: 'cwd="/host"' },
    engine_binary_paths: { codex: '/host/codex' }, projects: [{ path: '/host/project' }],
    user: { name: 'tester', home: '/host' }, remote_access: { enabled: true }, device: { id: 'host-device' },
  }
  const { config, warnings } = migrateConfig(source, { user: { name: 'existing' } }, { providers: true, engines: true, preferences: true })
  assert.equal(config.providers[0].api_key, 'test-secret')
  assert.equal(config.providers.length, 1)
  assert.equal(config.providers[0].custom_path, undefined)
  assert.deepEqual(config.engine_providers, { pydantic_ai: 'one' })
  assert.deepEqual(config.pydantic_ai_engine, { provider_id: 'one', model: 'test-model' })
  assert.deepEqual(config.codex_engine, { approval_policy: 'on-request' })
  assert.equal(config.user.name, 'existing')
  for (const key of ['engine_binary_paths', 'projects', 'device']) assert.equal(config[key], undefined)
  assert.deepEqual(config.remote_access, { enabled: true })
  assert.ok(warnings.some(w => w.includes('Local')))
  assert.ok(!JSON.stringify(warnings).includes('test-secret'))
  assert.equal(migrateConfig(source, {}, { engines: true }).config.pydantic_ai_engine.provider_id, undefined)
  assert.equal(migrateConfig(source, { user: { name: 'existing' } }, { preferences: true, overwrite: true }).config.user.name, 'tester')
})

test('preference migration keeps remote access password without copying invites or devices', () => {
  const { config } = migrateConfig({ remote_access: {
    enabled: true, internal_base_url: 'http://192.168.1.2:8766', external_base_url: 'https://work.example',
    host_id: 'host-id', access_password_salt: 'salt', access_password_hash: 'hash', access_password_set_at: 123,
    invites: [{ token: 'invite' }], devices: [{ credential: 'device' }],
  } }, {}, { preferences: true })
  assert.deepEqual(config.remote_access, {
    enabled: true, external_base_url: 'https://work.example', host_id: 'host-id',
    access_password_salt: 'salt', access_password_hash: 'hash', access_password_set_at: 123,
  })
})

test('project registration maps only explicitly selected mounted projects and preserves identity', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-project-map-'))
  try {
    const project = path.join(base, 'project'), outside = path.join(base, 'outside')
    await fs.mkdir(path.join(project, '.workstep'), { recursive: true })
    await fs.mkdir(outside)
    await fs.writeFile(path.join(project, '.workstep/workstep.db'), 'existing database')
    const mapped = await mapProjects({ project, mounts: [] }, [{ path: project, id: 'original', name: 'Existing' }], [project])
    assert.deepEqual(mapped, [{ path: '/data/projects', id: 'original', name: 'Existing', sort_order: 0 }])
    await assert.rejects(mapProjects({ project, mounts: [] }, [], [outside]), /挂载/)
    assert.deepEqual(await mapProjects({ project, mounts: [] }, [], []), [])
    assert.equal(await fs.readFile(path.join(project, '.workstep/workstep.db'), 'utf8'), 'existing database')
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('supplier name conflicts remap model bindings and caches instead of duplicating suppliers', () => {
  const source = { providers: [{ id: 'host', name: 'Same', api_key: 'host-key' }], engine_providers: { pydantic_ai: 'host' }, pydantic_ai_engine: { provider_id: 'host', model: '/host/local-model' }, provider_models: { 'host::openai_responses': { models: [{ id: 'model-one', cache_dir: '/host/cache' }], fetched_at: 'now' } } }
  const target = { providers: [{ id: 'sandbox', name: 'Same', api_key: 'sandbox-key' }] }
  const { config } = migrateConfig(source, target, { providers: true, engines: true })
  assert.equal(config.providers.length, 1)
  assert.equal(config.providers[0].api_key, 'sandbox-key')
  assert.equal(config.engine_providers.pydantic_ai, 'sandbox')
  assert.deepEqual(config.pydantic_ai_engine, { provider_id: 'sandbox' })
  assert.deepEqual(config.provider_models['sandbox::openai_responses'].models, [{ id: 'model-one' }])
})
