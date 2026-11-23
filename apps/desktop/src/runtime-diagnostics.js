;(function () {
  const sources = ['page', 'request', 'desktop', 'daemon', 'sandbox', 'fatal', 'android', 'notification', 'crash', 'webview']
  const levels = ['debug', 'info', 'warn', 'error']
  const eventTypes = [
    'frame', 'longtask', 'input', 'resource', 'atlas-particles', 'atlas-markers',
    'chat-first-chunk', 'chat-first-display', 'chat-stream-commit', 'chat-history', 'chat-react-render',
    'chat-follow', 'markdown-queue', 'markdown-parse', 'page-change',
  ]
  const pageNames = {
    home: '工作台首页', chat: '聊天工作台', companion: '数字人', tasks: '任务',
    canvas: '流程画布', git: 'Git 工作区', schedules: '定时安排', statistics: '统计',
    appearance: '外观设置', share: '分享任务', 'file-preview': '文件预览', devices: '设备列表', unknown: '未识别页面',
  }
  const featureNames = {
    composer: '消息输入框', 'message-list': '消息列表', 'message-stream': '消息流式渲染',
    markdown: '消息 Markdown 渲染', atlas: '记忆星图', camera: '相机',
    canvas: '流程画布', navigation: '工作台导航', settings: '设置',
  }
  const actionNames = {
    typing: '键盘输入', sending: '发送消息', scrolling: '滚动',
    interacting: '点击或触控',
  }
  const known = (names, value) => typeof value === 'string' && Object.prototype.hasOwnProperty.call(names, value)

  function pageFor(path) {
    const route = path.replace(/^\/workspace\/[^/]+(?=\/|$)/, '').replace(/\/$/, '')
    if (!route) return 'home'
    if (route.startsWith('/share/')) return 'share'
    if (route === '/devices/empty') return 'devices'
    const key = route.replace(/^\//, '')
    return known(pageNames, key) ? key : 'unknown'
  }

  function featureFor(node) {
    const matches = selector => node?.closest?.(selector)
    if (matches('.chat-input-root, .chat-input-editor')) return 'composer'
    if (matches('.llm-message-timeline')) return 'markdown'
    if (matches('.chat-history-scroll')) return 'message-list'
    if (matches('.memory-atlas-sky, .digital-home-atlas-toggle')) return 'atlas'
    if (matches('.digital-home-camera-perception, .digital-person-camera')) return 'camera'
    if (matches('.flow-canvas-workspace, .flow-canvas-toolbar')) return 'canvas'
    if (matches('[data-ui="settings"]')) return 'settings'
    if (matches('.responsive-navigation, .workspace-navigation')) return 'navigation'
  }

  function actionFor(type, node) {
    if (node?.closest?.('.chat-input-send')) return 'sending'
    if (['wheel', 'touchmove', 'scroll'].includes(type)) return 'scrolling'
    if (['keydown', 'keyup', 'keypress', 'beforeinput', 'input'].includes(type)) return 'typing'
    if (['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'].includes(type)) {
      return 'interacting'
    }
  }

  function explicitFeature(type) {
    if (type.startsWith('markdown-')) return 'markdown'
    if (type.startsWith('atlas-')) return 'atlas'
    if (type === 'chat-history' || type === 'chat-follow') return 'message-list'
    if (type.startsWith('chat-')) return 'message-stream'
  }

  function describeContext({ page, feature, action }) {
    return [known(pageNames, page) && pageNames[page], known(featureNames, feature) && featureNames[feature],
      known(actionNames, action) && actionNames[action]].filter(Boolean).join(' / ')
  }
  const maxEvents = 600
  const maxLogs = 600
  const maxBytes = 2 * 1024 * 1024

  function normalizeLogs(streams) {
    const logs = []
    let trimmed = false
    for (const { source, text } of streams) {
      if (!sources.includes(source) || typeof text !== 'string') continue
      trimmed ||= text.length > 256 * 1024 || text.startsWith('…[已截断')
      for (const entry of text.slice(-256 * 1024).split(/\n(?=\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d)/)) {
        const match = /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?)\s+([^\n]*)(?:\n([\s\S]*))?$/.exec(entry.trim())
        if (!match) continue
        const date = match[1].replace(' ', 'T').replace(',', '.')
        const at = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(date) ? date : date + 'Z')
        if (!Number.isFinite(at)) continue
        const line = match[2]
        const explicit = /^(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\b\s*/i.exec(line)
        const summary = line.slice(explicit?.[0].length || 0, (explicit?.[0].length || 0) + 1000)
        const severity = explicit?.[1].toLowerCase()
        const level = severity === 'warning' ? 'warn' : severity === 'fatal' || severity === 'critical' ? 'error' :
          severity || (/(失败|异常|错误|崩溃|Exception|Traceback)/.test(line) ? 'error' : /超时/.test(line) ? 'warn' : 'info')
        const logSource = source === 'android' && /网页(脚本|加载|资源|进程|渲染)/.test(line) ? 'webview' : source
        logs.push({ at, source: logSource, level, summary, detail: match[3]?.slice(0, 4000) })
      }
    }
    const tail = logs.sort((a, b) => b.at - a.at).slice(0, maxLogs)
    Object.defineProperty(tail, 'trimmed', { value: trimmed || logs.length > maxLogs })
    return tail
  }

  function filterLogs(logs, { source, level, query, from, to } = {}) {
    const needle = query?.trim().toLowerCase()
    return logs.filter(log => (!source || log.source === source) && (!level || log.level === level) &&
      (from == null || log.at >= from) && (to == null || log.at <= to) &&
      (!needle || (log.summary + '\n' + (log.detail || '')).toLowerCase().includes(needle)))
  }

  function safeLog(log) {
    const text = log.summary + '\n' + (log.detail || '')
    const signatures = text.match(/\b(?:TypeError|SyntaxError|ReferenceError|RangeError|TimeoutError|AbortError|SecurityError|IOException|NullPointerException|IllegalStateException|Traceback)\b|\bHTTP [1-5]\d{2}\b|失败|异常|超时|崩溃|断开|重连|启动|退出|恢复|请求|通知/g)
    const frames = Array.from(text.matchAll(/\b([a-zA-Z][\w.-]{0,80}\.(?:js|mjs|tsx?|py|cjs|java)):(\d{1,7})(?::(\d{1,7}))?/g), match =>
      [match[1], match[2], match[3]].filter(Boolean).join(':')).slice(0, 5)
    return {
      at: log.at, source: log.source, level: log.level,
      summary: [...new Set(signatures || [])].slice(0, 10).join(' / ') || log.level,
      ...(frames.length ? { frames } : {}),
    }
  }

  function buildReport(environment, recording, logs) {
    const clean = Object.fromEntries(Object.entries(environment).filter(([key, value]) =>
      ['platform', 'version', 'runtime', 'os'].includes(key) && typeof value === 'string' && /^[\w .()+/-]{1,120}$/.test(value)))
    const sample = recording && {
      startedAt: recording.startedAt, duration: recording.duration,
      reason: ['manual', 'timeout', 'hidden', 'navigation'].includes(recording.reason) ? recording.reason : undefined,
      build: /^index-[\w-]{1,80}\.js$/.test(recording.build) ? recording.build : undefined,
      viewport: recording.viewport?.slice(0, 3).filter(Number.isFinite),
      aggregates: recording.aggregates && Object.fromEntries(
        ['idleFrame', 'inputFrame', 'resources', 'atlasParticles', 'atlasMarkers']
          .filter(key => Array.isArray(recording.aggregates[key]))
          .map(key => [key, recording.aggregates[key].slice(0, 4).filter(Number.isFinite)])),
      frames: recording.frames && Object.fromEntries(['count', 'average', 'worst'].filter(key =>
        Number.isFinite(recording.frames[key])).map(key => [key, recording.frames[key]])),
      pages: Array.isArray(recording.pages) ? recording.pages
        .filter(entry => Number.isFinite(entry.at) && known(pageNames, entry.page)).slice(0, 64)
        .map(({ at, page }) => ({ at, page })) : undefined,
      nodes: Number.isFinite(recording.nodes) ? recording.nodes : undefined,
      heapMiB: Number.isFinite(recording.heapMiB) ? recording.heapMiB : undefined,
      supported: Array.isArray(recording.supported) ? recording.supported.filter(type => eventTypes.includes(type)) : undefined,
      events: recording.events.filter(event => eventTypes.includes(event.type) &&
        Number.isFinite(event.at) && Number.isFinite(event.duration)).slice(0, maxEvents)
        .map(({ type, at, duration, page, feature, action }) => ({
          type, at, duration, page: known(pageNames, page) ? page : undefined,
          feature: known(featureNames, feature) ? feature : undefined,
          action: known(actionNames, action) ? action : undefined,
        })),
    }
    const ordered = recording ? [...logs].sort((a, b) =>
      distanceFromRecording(a.at, recording) - distanceFromRecording(b.at, recording)) : logs
    const report = {
      schemaVersion: 1, exportedAt: new Date().toISOString(), environment: clean,
      recording: sample || null, logs: ordered.slice(0, maxLogs).map(safeLog),
      truncated: ordered.length > maxLogs || Boolean(logs.trimmed || recording?.truncated),
    }
    let output = JSON.stringify(report, null, 2)
    const encoder = new TextEncoder()
    while (encoder.encode(output).length > maxBytes && report.logs.length) {
      report.logs.length = Math.floor(report.logs.length / 2)
      report.truncated = true
      output = JSON.stringify(report, null, 2)
    }
    return output
  }

  function distanceFromRecording(at, { startedAt, duration }) {
    return Math.max(startedAt - at, at - startedAt - duration, 0)
  }

  function createPerformanceRecorder(target) {
    let active = null
    let latest = null
    let generation = 0
    const notify = () => target.dispatchEvent(new target.Event('workstep:runtime-capture'))
    const now = () => target.performance.now()
    return {
      start() {
        if (active || target.document.hidden) return false
        const started = now()
        const events = []
        const observers = []
        const interactions = new Map()
        const samples = { idleFrame: [], inputFrame: [], resources: [], atlasParticles: [], atlasMarkers: [] }
        const sample = (name, value) => {
          if (Number.isFinite(value) && samples[name].length < 3000) samples[name].push(value)
        }
        let lastInput = -Infinity
        let checkedPath = target.location?.pathname ?? ''
        const pages = [{ at: 0, page: pageFor(checkedPath) }]
        const actions = []
        const onInput = event => {
          const receivedAt = now()
          lastInput = receivedAt
          if (event.type === 'pointermove') return
          const action = actionFor(event.type, event.target)
          const previous = actions.at(-1)
          if (action === 'scrolling' && previous?.action === action && receivedAt - previous.at < 80) return
          rememberPage(receivedAt)
          const at = event.timeStamp >= started && event.timeStamp <= receivedAt ? event.timeStamp : receivedAt
          if (actions.length >= maxEvents) actions.shift()
          actions.push({ at, page: pages.at(-1).page, feature: featureFor(event.target), action })
        }
        const inputTypes = ['pointerdown', 'pointermove', 'click', 'keydown', 'input', 'wheel', 'touchmove']
        const supported = ['frame']
        let truncated = false
        let frame
        let previous
        let elapsed = 0
        let count = 0
        let worst = 0
        const add = (type, at, duration, node, inputType) => {
          if (!Number.isFinite(at) || !Number.isFinite(duration) || duration < 0 || at < started ||
            !eventTypes.includes(type)) return
          if (type.startsWith('atlas-') && duration < 4) return
          if (events.length === maxEvents) {
            truncated = true
            const incidental = events.findIndex(event => event.type.startsWith('atlas-') ||
              event.type === 'chat-follow' || event.type === 'chat-stream-commit')
            if (incidental < 0 || ['chat-follow', 'chat-stream-commit'].includes(type) || type.startsWith('atlas-')) return
            events.splice(incidental, 1)
          }
          const offset = Math.round(at - started)
          let page = pages[0].page
          for (let index = pages.length - 1; index >= 0; index--) {
            if (pages[index].at <= offset) { page = pages[index].page; break }
          }
          let near
          if (type === 'input' || type === 'frame' || type === 'longtask') {
            for (let index = actions.length - 1; index >= 0; index--) {
              const action = actions[index]
              if (action.at > at) continue
              if (at - action.at <= 200 && action.page === page) near = action
              break
            }
          }
          const event = { type, at: offset, duration: Math.round(duration), page,
            feature: explicitFeature(type) ?? featureFor(node) ?? near?.feature,
            action: type === 'chat-first-chunk' ? 'sending' : actionFor(inputType, node) ?? near?.action }
          events.push(event)
          return event
        }
        const rememberPage = at => {
          const path = target.location?.pathname ?? ''
          if (path === checkedPath) return
          checkedPath = path
          const page = pageFor(path)
          if (page === pages.at(-1).page) return
          if (pages.length === 64) { truncated = true; return }
          pages.push({ at: Math.round(at - started), page })
          add('page-change', at, 0)
        }
        const types = [
          ['longtask', 'longtask', 50], ['event', 'input', 32], ['resource', 'resource', 200],
        ]
        for (const [entryType, type, minimum] of types) {
          if (!target.PerformanceObserver?.supportedEntryTypes?.includes(entryType)) continue
          const receive = entries => {
            for (const item of entries) {
              if (item.startTime < started) continue
              if (type === 'resource') sample('resources', item.duration)
              if (item.duration < minimum) continue
              if (type !== 'input') { add(type, item.startTime, item.duration); continue }
              const key = item.interactionId || -Math.floor(item.startTime / 8)
              const previous = interactions.get(key)
              if (previous) previous.duration = Math.max(previous.duration, Math.round(item.duration))
              else {
                const event = add(type, item.startTime, item.duration, item.target, item.name)
                if (event) interactions.set(key, event)
              }
            }
          }
          let observer
          try {
            observer = new target.PerformanceObserver(list => receive(list.getEntries()))
            observer.observe(entryType === 'event' ? { type: entryType, durationThreshold: minimum } : { type: entryType })
            observers.push({ observer, receive })
            supported.push(type)
          } catch { observer?.disconnect() }
        }
        const draw = event => {
          const at = now()
          sample('atlasParticles', event.detail?.particles)
          sample('atlasMarkers', event.detail?.markers)
          add('atlas-particles', at, event.detail?.particles)
          add('atlas-markers', at, event.detail?.markers)
        }
        const document = target.document
        const sky = document.querySelector('.memory-atlas-sky')
        sky?.setAttribute('data-atlas-sampling', '')
        sky?.addEventListener('workstep:atlas-profile-frame', draw)
        const visibility = () => { if (document.hidden) finish('hidden') }
        const navigation = () => finish('navigation')
        const finish = reason => {
          if (!active) return latest
          active = null
          target.clearTimeout(timeout)
          target.cancelAnimationFrame(frame)
          document.removeEventListener('visibilitychange', visibility)
          for (const type of inputTypes) document.removeEventListener(type, onInput, true)
          target.removeEventListener('pagehide', navigation)
          sky?.removeEventListener('workstep:atlas-profile-frame', draw)
          sky?.removeAttribute('data-atlas-sampling')
          for (const { observer, receive } of observers) { receive(observer.takeRecords()); observer.disconnect() }
          const build = Array.from(document.scripts, script => script.src.split('/').pop())
            .find(name => /^index-[\w-]{1,80}\.js$/.test(name))
          const heap = target.performance.memory?.usedJSHeapSize
          const aggregates = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
            values.sort((a, b) => a - b)
            const percentile = fraction => Math.round(values[Math.ceil(values.length * fraction) - 1] || 0)
            return [name, [values.length, percentile(.5), percentile(.95), percentile(1)]]
          }))
          latest = {
            startedAt: target.performance.timeOrigin + started, duration: Math.round(now() - started), reason,
            supported, build, viewport: [target.innerWidth, target.innerHeight, target.devicePixelRatio],
            nodes: document.getElementsByTagName('*').length, heapMiB: Number.isFinite(heap) ? Math.round(heap / 1048576) : null,
            frames: { count, average: count ? Math.round(elapsed / count) : 0, worst: Math.round(worst) },
            aggregates, pages, events: events.sort((a, b) => a.at - b.at), truncated,
          }
          notify()
          return latest
        }
        const tick = at => {
          rememberPage(at)
          if (previous !== undefined) {
            const interval = at - previous
            count++; elapsed += interval; worst = Math.max(worst, interval)
            sample(at - lastInput < 150 ? 'inputFrame' : 'idleFrame', interval)
            if (interval >= 34) add('frame', previous, interval)
          }
          previous = at
          frame = target.requestAnimationFrame(tick)
        }
        latest = null
        active = { finish, add, started, id: ++generation }
        const timeout = target.setTimeout(() => finish('timeout'), 15000)
        document.addEventListener('visibilitychange', visibility)
        for (const type of inputTypes) document.addEventListener(type, onInput, { capture: true, passive: true })
        target.addEventListener('pagehide', navigation)
        frame = target.requestAnimationFrame(tick)
        notify()
        return true
      },
      stop(reason = 'manual') { return active?.finish(reason) ?? latest },
      snapshot() { return { recording: Boolean(active), result: latest } },
      stamp() { return active ? now() : undefined },
      captureId() { return active?.id },
      mark(type, startedAt, duration = 0) {
        if (active && startedAt !== undefined) active.add(type, startedAt, duration)
      },
    }
  }

  const api = { normalizeLogs, filterLogs, buildReport, createPerformanceRecorder, describeContext, levels, sources }
  if (typeof module === 'object' && module.exports) module.exports = api
  if (typeof window !== 'undefined' && !window.workstepRuntimeDiagnostics) {
    window.workstepRuntimeDiagnostics = api
    window.workstepPerformance = createPerformanceRecorder(window)
  }
})()
