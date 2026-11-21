(() => {
  const started = performance.now();
  const sky = document.querySelector('.memory-atlas-sky');
  const marker = sky?.querySelector('.atlas-star');
  const intervals = { idle: [], touch: [], redraw: [], particles: [], markers: [] };
  const add = (key, value) => {
    if (Number.isFinite(value) && intervals[key].length < 2000) intervals[key].push(value);
  };
  const recordDraw = event => {
    for (const key of ['particles', 'markers']) add(key, event.detail?.[key]);
  };
  if (sky && marker) {
    sky.setAttribute('data-atlas-sampling', '');
    sky.addEventListener('workstep:atlas-profile-frame', recordDraw);
  }
  let lastFrame = started;
  let lastRedraw;
  let lastInput = -Infinity;
  let frame;
  let longTasks = -1;
  let longTaskMs = 0;
  let tasks;
  let stopped = false;
  const input = () => { lastInput = performance.now(); };
  const markerObserver = new MutationObserver(() => {
    const now = performance.now();
    if (lastRedraw !== undefined) add('redraw', now - lastRedraw);
    lastRedraw = now;
  });
  if (marker) markerObserver.observe(marker, { attributes: true, attributeFilter: ['style'] });
  if (window.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
    tasks = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        longTasks++;
        longTaskMs += entry.duration;
      }
    });
    tasks.observe({ entryTypes: ['longtask'] });
    longTasks = 0;
  }
  for (const type of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'keydown', 'wheel']) {
    document.addEventListener(type, input, { passive: true });
  }
  function tick(now) {
    if (document.hidden) {
      cleanup();
      return;
    }
    add(now - lastInput < 150 ? 'touch' : 'idle', now - lastFrame);
    lastFrame = now;
    frame = requestAnimationFrame(tick);
  }
  function cleanup() {
    stopped = true;
    delete window.__workstepAtlasSample;
    cancelAnimationFrame(frame);
    clearTimeout(timeout);
    markerObserver.disconnect();
    if (tasks) {
    for (const entry of tasks.takeRecords()) {
      longTasks++;
      longTaskMs += entry.duration;
    }
      tasks.disconnect();
    }
    for (const type of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'keydown', 'wheel']) {
      document.removeEventListener(type, input);
    }
    if (sky && marker) {
      sky.removeEventListener('workstep:atlas-profile-frame', recordDraw);
      sky.removeAttribute('data-atlas-sampling');
    }
  }
  function summarize(samples) {
    samples.sort((a, b) => a - b);
    const percentile = fraction => Math.round(samples[Math.ceil(samples.length * fraction) - 1] || 0);
    return [samples.length, percentile(.5), percentile(.95), percentile(1)];
  }
  frame = requestAnimationFrame(tick);
  const timeout = setTimeout(cleanup, 17000);
  window.__workstepAtlasSample = report => {
    if (stopped) return null;
    cleanup();
    if (!report || document.hidden) return null;
    const resources = performance.getEntriesByType('resource')
      .filter(entry => entry.startTime >= started);
    const heap = performance.memory?.usedJSHeapSize;
    return {
      ms: Math.round(performance.now() - started),
      path: location.pathname,
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      nodes: document.getElementsByTagName('*').length,
      build: Array.from(document.scripts, script => script.src.split('/').pop())
        .find(name => /^index-[\w-]+\.js$/.test(name)) || '',
      idle: summarize(intervals.idle),
      touch: summarize(intervals.touch),
      longTasks,
      longTaskMs: Math.round(longTaskMs),
      resources: summarize(resources.map(entry => entry.duration)),
      heapMiB: Number.isFinite(heap) ? Math.round(heap / 1048576) : -1,
      atlas: sky && marker && sky.isConnected ? {
        stars: sky.querySelectorAll('.atlas-star').length,
        renderer: sky.querySelector('canvas[data-atlas-renderer]')?.dataset.atlasRenderer || '',
        redraw: summarize(intervals.redraw),
        particles: summarize(intervals.particles),
        markers: summarize(intervals.markers),
      } : null,
    };
  };
  return true;
})()
