;(function () {
  const names = {
    page: '页面', request: '请求', desktop: '桌面', daemon: '后台', sandbox: '沙箱', fatal: '桌面崩溃',
    android: '安卓', notification: '通知进程', crash: '崩溃', webview: 'WebView',
    debug: '调试', info: '信息', warn: '警告', error: '错误',
    frame: '慢帧', longtask: '长任务', input: '输入延迟', resource: '慢资源请求',
    'atlas-particles': '星图粒子绘制', 'atlas-markers': '星图标记更新',
    'chat-first-chunk': '发送至首个流式片段', 'chat-first-display': '首个片段至页面提交',
    'chat-stream-commit': '流式提交', 'chat-react-render': '消息 React 子树渲染', 'chat-history': '历史消息加载至提交', 'chat-follow': '消息跟随滚动',
    'markdown-queue': 'Markdown 排队', 'markdown-parse': 'Markdown Worker 解析', 'page-change': '页面切换',
  }

  window.mountWorkstepDiagnostics = function mount(root, adapter) {
    const { filterLogs, buildReport, describeContext, levels } = window.workstepRuntimeDiagnostics
    root.innerHTML = `
      <div class="rd-toolbar" role="tablist" aria-label="诊断视图">
        <button type="button" role="tab" id="rd-logs-tab" aria-controls="rd-logs" aria-selected="true">日志</button>
        <button type="button" role="tab" id="rd-performance-tab" aria-controls="rd-performance" aria-selected="false" tabindex="-1">性能</button>
      </div>
      <div role="tabpanel" id="rd-logs" aria-labelledby="rd-logs-tab" class="rd-pane">
        <div class="rd-filters">
          <input type="search" placeholder="搜索日志" aria-label="搜索日志">
          <select aria-label="日志来源"><option value="">全部来源</option></select>
          <select aria-label="日志级别"><option value="">全部级别</option></select>
          <select aria-label="日志时间"><option value="1">最近 1 分钟</option><option value="5" selected>最近 5 分钟</option><option value="30">最近 30 分钟</option><option value="">所有时间</option></select>
          <button type="button" data-action="refresh">刷新</button>
          <button type="button" data-action="copy-logs" disabled>复制筛选日志</button>
        </div>
        <div class="rd-rows" aria-label="日志记录"><p>正在读取日志…</p></div>
      </div>
      <div role="tabpanel" id="rd-performance" aria-labelledby="rd-performance-tab" class="rd-pane" hidden>
        <div class="rd-toolbar">
          <button type="button" data-action="capture" disabled>录制 15 秒</button>
          <select aria-label="性能事件类型" hidden>
            <option value="">全部事件</option><option value="chat">消息处理</option>
            <option value="responsive">页面响应</option><option value="resource">资源请求</option>
            <option value="atlas">星图绘制</option>
          </select>
          <span class="rd-capture-state"></span>
        </div>
        <div class="rd-events"></div>
      </div>
      <div class="rd-footer">
        <button type="button" data-action="copy">复制完整报告</button>
        <button type="button" data-action="export">导出报告</button>
        <button type="button" data-action="manage" hidden>日志管理</button>
        <span class="rd-status" role="status"></span>
      </div>`
    const query = selector => root.querySelector(selector)
    const tabs = [...root.querySelectorAll('[role=tab]')]
    const [search, source, level, time] = root.querySelectorAll('.rd-filters input, .rd-filters select')
    const copyLogs = query('[data-action=copy-logs]')
    const rows = query('.rd-rows')
    const events = query('.rd-events')
    const capture = query('[data-action=capture]')
    const eventFilter = query('#rd-performance select')
    const status = query('.rd-status')
    const localTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' })
    let state = { logs: [], performance: {}, environment: {}, available: false }
    let selectedTime
    let readingLogs = false
    let readingStatus = false
    let disposed = false
    let expanded = 100
    let firstRead = true

    function node(tag, text) {
      const item = root.ownerDocument.createElement(tag)
      if (text !== undefined) item.textContent = text
      return item
    }
    function selectTab(index, focus = false) {
      for (const [i, tab] of tabs.entries()) {
        tab.setAttribute('aria-selected', String(i === index))
        tab.tabIndex = i === index ? 0 : -1
        query('#' + tab.getAttribute('aria-controls')).hidden = i !== index
      }
      if (focus) tabs[index].focus()
    }
    for (const [index, tab] of tabs.entries()) {
      tab.onclick = () => selectTab(index)
      tab.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        selectTab(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index, true)
      }
    }
    function shownLogs() {
      return filterLogs(state.logs, { source: source.value, level: level.value, query: search.value,
        from: selectedTime != null ? selectedTime - 5000 : time.value ? Date.now() - Number(time.value) * 60000 : undefined,
        to: selectedTime != null ? selectedTime + 5000 : undefined })
    }
    function renderLogs() {
      const visible = shownLogs()
      copyLogs.disabled = visible.length === 0
      const fragment = root.ownerDocument.createDocumentFragment()
      if (selectedTime != null) {
        const clear = node('button', '清除时段筛选')
        clear.type = 'button'
        clear.onclick = () => { selectedTime = undefined; renderLogs() }
        fragment.append(clear)
      }
      if (!visible.length) fragment.append(node('p', '此范围暂无日志'))
      for (const log of visible.slice(0, expanded)) {
        const row = node('details')
        const heading = node('summary')
        heading.append(node('time', localTime.format(log.at)), node('span', names[log.source] || log.source),
          node('span', names[log.level] || log.level), node('span', log.summary))
        const detail = node('pre', log.detail ? log.summary + '\n' + log.detail : log.summary)
        row.append(heading, detail)
        fragment.append(row)
      }
      if (visible.length > expanded) {
        const more = node('button', '查看更早的记录')
        more.type = 'button'
        more.onclick = () => { expanded += 100; renderLogs() }
        fragment.append(more)
      }
      rows.replaceChildren(fragment)
    }
    const offsetText = at => `+${(at / 1000).toFixed(3)} s`
    function formatPages(pages) {
      return (pages || []).slice(0, 6).map(page =>
        page.at ? `${offsetText(page.at)} ${describeContext(page)}` : describeContext(page)).join(' → ')
    }
    function renderPerformance() {
      const { recording, result } = state.performance
      capture.textContent = recording ? '停止录制' : '录制 15 秒'
      capture.disabled = !recording && !state.available
      query('.rd-capture-state').textContent = recording ? '正在录制，回到工作台复现问题' :
        state.available ? '' : '工作台页面当前不可用'
      events.replaceChildren()
      eventFilter.hidden = !result
      if (!result) return
      const { frames, viewport } = result
      events.append(node('p', '录制页面：' + (formatPages(result.pages) || '这份录制未记录页面')))
      events.append(node('p', [
        `录制 ${(result.duration / 1000).toFixed(1)} 秒`,
        frames && `最长帧间隔 ${frames.worst} ms`, viewport && `${viewport[0]} × ${viewport[1]}`,
        Number.isFinite(result.nodes) && `DOM 节点 ${result.nodes}`,
        Number.isFinite(result.heapMiB) && `JS 堆 ${result.heapMiB} MiB`,
        result.truncated && '已省略部分事件',
      ].filter(Boolean).join('　')))
      const aggregateLabels = { idleFrame: '静置帧间隔', inputFrame: '交互帧间隔', resources: '资源请求',
        atlasParticles: '星图粒子', atlasMarkers: '星图标记' }
      const activeAggregates = Object.entries(result.aggregates || {}).filter(([, values]) => values[0] > 0)
      if (activeAggregates.length) {
        const metrics = node('details')
        metrics.append(node('summary', '耗时统计'))
        for (const [key, [count, median, p95, worst]] of activeAggregates) {
          metrics.append(node('p', `${aggregateLabels[key]}　${count} 次　中位数 ${median} ms　P95 ${p95} ms　最长 ${worst} ms`))
        }
        events.append(metrics)
      }
      const missing = ['longtask', 'input', 'resource'].filter(type => !result.supported?.includes(type))
      if (missing.length) events.append(node('p', '当前环境不可用：' + missing.map(type => names[type]).join('、')))
      const visible = result.events.filter(({ type }) => {
        if (eventFilter.value === 'chat') return type.startsWith('chat-') || type.startsWith('markdown-')
        if (eventFilter.value === 'responsive') return ['frame', 'input', 'longtask'].includes(type)
        if (eventFilter.value === 'atlas') return type.startsWith('atlas-')
        return !eventFilter.value || type === eventFilter.value
      })
      if (!visible.length) events.append(node('p', '此范围暂无性能事件'))
      const list = node('ol')
      for (const event of visible) {
        const row = node('li')
        const button = node('button')
        button.type = 'button'
        const description = node('span')
        description.append(node('span', names[event.type] || event.type))
        const context = describeContext(event)
        if (context) {
          const detail = node('small', context)
          detail.className = 'rd-event-context'
          description.append(detail)
        }
        button.append(node('time', offsetText(event.at)), description,
          node('span', event.duration ? `${event.duration} ms` : ''))
        button.onclick = () => {
          selectedTime = result.startedAt + event.at
          search.value = source.value = level.value = ''
          time.value = '5'
          selectTab(0, true)
          renderLogs()
          void refresh()
        }
        row.append(button)
        list.append(row)
      }
      events.append(list)
    }
    async function refresh(full = true) {
      if (disposed || (full ? readingLogs : readingStatus)) return
      if (full) readingLogs = true
      else readingStatus = true
      try {
        const update = await adapter.read(full)
        if (disposed) return
        if (full) {
          state.logs = update.logs ?? []
          state.warning = update.warning
          state.environment = update.environment
          const selected = source.value
          source.replaceChildren(new Option('全部来源', ''), ...[...new Set(state.logs.map(log => log.source))]
            .map(item => new Option(names[item] || item, item)))
          source.value = selected
          renderLogs()
          if (state.warning) status.textContent = state.warning
        } else {
          const previous = state.performance
          const availabilityChanged = state.available !== update.available
          state = { ...state, ...update }
          if (firstRead) {
            renderPerformance()
            firstRead = false
            if (state.performance.recording || state.performance.result) selectTab(1)
          }
          if (availabilityChanged || previous.recording !== state.performance.recording ||
              previous.result?.startedAt !== state.performance.result?.startedAt) renderPerformance()
        }
      } catch { if (!disposed) status.textContent = '读取诊断数据失败，请重试' }
      finally { if (full) readingLogs = false; else readingStatus = false }
    }
    eventFilter.onchange = renderPerformance
    for (const value of levels) level.add(new Option(names[value], value))
    search.oninput = source.onchange = level.onchange = () => { expanded = 100; renderLogs() }
    time.onchange = () => { selectedTime = undefined; renderLogs() }
    query('[data-action=refresh]').onclick = () => { status.textContent = ''; void refresh() }
    capture.onclick = async () => {
      capture.disabled = true
      try {
        if (state.performance.recording) { await adapter.stop(); await refresh(false); void refresh() }
        else if (!(await adapter.start())) status.textContent = '无法录制当前页面，请重试'
        else if (!disposed) await refresh(false)
      } catch { status.textContent = '录制操作失败，请重试' }
      finally { if (!disposed) capture.disabled = !state.available && !state.performance.recording }
    }
    async function copyReport(recording, logs, success) {
      try {
        await adapter.copy(buildReport(state.environment, recording, logs))
        if (!disposed) status.textContent = success
      } catch { if (!disposed) status.textContent = '复制失败，请重试' }
    }
    query('[data-action=copy]').onclick = () => copyReport(state.performance.result, state.logs, '完整报告已复制')
    copyLogs.onclick = () => {
      const logs = shownLogs()
      if (!logs.length) { renderLogs(); return }
      return copyReport(null, logs, `已复制 ${logs.length} 条筛选日志`)
    }
    query('[data-action=export]').onclick = async () => {
      try {
        if (await adapter.save(buildReport(state.environment, state.performance.result, state.logs)) && !disposed) status.textContent = '已导出'
      } catch { if (!disposed) status.textContent = '导出失败' }
    }
    if (adapter.manage) {
      const manage = query('[data-action=manage]')
      manage.hidden = false
      manage.onclick = () => { void adapter.manage() }
    }
    void refresh()
    void refresh(false)
    const timer = setInterval(() => { void refresh(false) }, 1000)
    return () => { disposed = true; clearInterval(timer); root.replaceChildren() }
  }
})()
