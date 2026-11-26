const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

/** The same narrow native protocol is implemented by Android's CalendarHost. */
function createCalendarHost({ ipcMain, app, shell, trusted, invokeProvider }) {
  let chain = Promise.resolve()
  const provider = invokeProvider || (input => new Promise((resolve, reject) => {
    const executable = app.isPackaged ? path.join(process.resourcesPath, 'calendar-helper') : path.join(__dirname, '../build/calendar-helper')
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    let output = '', size = 0
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Calendar provider timed out')) }, 120000)
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > 262144) { child.kill(); return reject(new Error('Calendar provider response too large')) }
      output += chunk
    })
    child.once('error', reject)
    child.once('close', code => {
      clearTimeout(timeout)
      try { if (code !== 0) throw new Error('Calendar provider failed'); resolve(JSON.parse(output)) } catch (error) { reject(error) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input) + '\n')
  }))
  async function invoke(event, action, value = {}) {
    if (!trusted(event)) throw new Error('Untrusted calendar sender')
    if (process.platform !== 'darwin' && !invokeProvider) return { permission: 'unsupported', calendars: [] }
    if (JSON.stringify(value).length > 240000) throw new Error('Calendar request too large')
    const namespace = String(value.namespace || '')
    if (!namespace || namespace.length > 1000) throw new Error('Missing calendar host namespace')
    const file = path.join(app.getPath('userData'), 'calendar', crypto.createHash('sha256').update(namespace).digest('hex') + '.json')
    let state
    try { state = JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      state = { device_id: crypto.randomUUID(), key: crypto.randomBytes(32).toString('hex') }
    }
    const recordFile = (kind, id) => path.join(file + '.records', kind + '-' + crypto.createHash('sha256').update(id).digest('hex') + '.json')
    const readRecord = async (kind, id) => {
      try { return JSON.parse(await fs.readFile(recordFile(kind,id), 'utf8')) } catch(error) { if(error.code==='ENOENT')return null;throw error }
    }
    const writeRecord = async (kind,id,value) => {
      const destination=recordFile(kind,id)
      await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700})
      await fs.writeFile(destination+'.tmp',JSON.stringify(value),{mode:0o600})
      await fs.rename(destination+'.tmp',destination)
    }
    const save = async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = file + '.tmp'
      await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
      await fs.rename(temporary, file)
    }
    if (action === 'identity') { await save(); return { device_id: state.device_id, key: state.key, name: require('node:os').hostname(), platform: 'macos' } }
    if (action === 'settings') { await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'); return {} }
    if (['status','permission','calendars'].includes(action)) return provider({ action })
    if (action !== 'execute') throw new Error('Unknown calendar action')
    const { operation, item } = value
    if (!operation || !item || !/^[\w-]{1,100}$/.test(item.id) || !['create','update','delete','query'].includes(operation.action)) throw new Error('Invalid calendar operation')
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ operation: operation.id, action: operation.action, calendar: operation.calendar_id,
      item: item.id, draft: item.draft, system_id: operation.action==='create'?null:item.system_id, revision:item.revision, duration:item.duration_minutes })).digest('hex')
    const previous = await readRecord('item',item.id)
    if (previous && previous.fingerprint !== fingerprint) throw new Error('Calendar idempotency conflict')
    if (previous?.result?.status === 'succeeded') return previous.result
    if (previous?.phase === 'unknown' && operation.action === 'create') {
      const result = { item_id: item.id, ...await provider({ action: 'query_created', calendar_id: operation.calendar_id, item }) }
      if (result.status === 'succeeded') {
        await writeRecord('event',result.system_id,{calendar_id:operation.calendar_id})
        await writeRecord('item',item.id,{ fingerprint, phase: result.status, result })
      }
      return result
    }
    if (operation.action !== 'create' && (await readRecord('event',item.system_id))?.calendar_id !== operation.calendar_id) throw new Error('Calendar event is not owned by this installation')
    const status = await provider({ action: 'status' })
    if (status.permission !== 'granted') return { item_id: item.id, status: 'failed', error_code: 'permission_required' }
    await writeRecord('item',item.id,{fingerprint,phase:'unknown'})
    let result
    try { result = { item_id: item.id, ...await provider({ action: operation.action, calendar_id: operation.calendar_id, item }) } }
    catch { result = { item_id: item.id, status: 'unknown', error_code: 'verification_unknown' } }
    if (result.status === 'succeeded' && operation.action === 'create') await writeRecord('event',result.system_id,{calendar_id:operation.calendar_id})
    await writeRecord('item',item.id,{fingerprint,phase:result.status,result})
    return result
  }
  ipcMain.handle('workstep:calendar', (event, action, value) => {
    const next = chain.then(() => invoke(event, action, value))
    chain = next.catch(() => {})
    return next
  })
  return { dispose() { ipcMain.removeHandler('workstep:calendar') } }
}
module.exports = { createCalendarHost }
