/** JSON data belonging to one user/device, skin and feature; revisions are deliberately excluded. */
export interface FeatureBackup { format: 'workstep-feature-data'; version: 1; entries: [string, unknown][] }
export interface FeatureStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  export(): Promise<FeatureBackup>
  import(data: FeatureBackup): Promise<void>
}

function checkedKey(key: string) {
  if (typeof key !== 'string' || !key || key.length > 256) throw new Error('本地数据键无效')
  return key
}
function jsonValue(value: unknown): unknown {
  const source = JSON.stringify(value)
  if (source === undefined) throw new Error('本地数据必须可序列化为 JSON')
  return JSON.parse(source)
}

export function createFeatureStorage(scope: string, skinId: string, featureId: string): FeatureStorage {
  const namespace = JSON.stringify([scope, skinId, featureId])
  const run = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, resolve: (result: T) => void) => void): Promise<T> => {
    if (!globalThis.indexedDB) throw new Error('当前浏览器无法保存本地数据')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('workstep-feature-data', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('records')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error ?? new Error('本地数据库打开失败'))
      open.onblocked = () => reject(new Error('本地数据库被其他窗口占用，请关闭旧窗口后重试'))
    })
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction('records', mode)
        let result: T
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('本地数据保存失败'))
        try { operation(transaction.objectStore('records'), value => { result = value }) }
        catch (error) { transaction.abort(); reject(error) }
      })
    } finally { db.close() }
  }
  const range = () => IDBKeyRange.bound([namespace], [namespace, []])
  const entries = () => run<[string, unknown][]>('readonly', (store, done) => {
    const rows: [string, unknown][] = []
    const request = store.openCursor(range())
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { done(rows); return }
      rows.push([(cursor.key as string[])[1], cursor.value]); cursor.continue()
    }
  })
  return {
    get: <T>(key: string) => run<T | undefined>('readonly', (store, done) => {
      const request = store.get([namespace, checkedKey(key)])
      request.onsuccess = () => done(request.result)
    }),
    set: async (key, value) => {
      const checked = checkedKey(key), data = jsonValue(value)
      await run<void>('readwrite', (store, done) => { store.put(data, [namespace, checked]); done() })
    },
    delete: async key => { await run<void>('readwrite', (store, done) => { store.delete([namespace, checkedKey(key)]); done() }) },
    list: async () => (await entries()).map(([key]) => key),
    export: async () => ({ format: 'workstep-feature-data', version: 1, entries: await entries() }),
    import: async data => {
      if (!data || data.format !== 'workstep-feature-data' || data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 10000) throw new Error('本地数据备份格式无效')
      const checked = data.entries.map(row => {
        if (!Array.isArray(row) || row.length !== 2) throw new Error('本地数据备份条目无效')
        return [checkedKey(row[0]), jsonValue(row[1])] as const
      })
      await run<void>('readwrite', (store, done) => {
        store.delete(range())
        for (const [key, value] of checked) store.put(value, [namespace, key])
        done()
      })
    },
  }
}
