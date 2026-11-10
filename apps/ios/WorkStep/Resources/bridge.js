// __workstepOrigin is supplied as a JSON string by the native shell.
(() => {
  if (window.top !== window || location.origin !== __workstepOrigin) return;
  const send = value => window.webkit.messageHandlers.workstep.postMessage(value);
  Object.defineProperty(window, 'WorkStepIOS', { value: Object.freeze({
    postMessage(raw) {
      if (typeof raw !== 'string' || raw.length > 65536) return;
      try { const value = JSON.parse(raw); if (value && typeof value === 'object') send(value); } catch {}
    }
  }) });
  window.addEventListener('error', event => {
    const allowed = ['TypeError', 'SyntaxError', 'ReferenceError', 'RangeError'];
    const code = allowed.includes(event.error?.name) ? event.error.name : 'resource-error';
    let path = '';
    try { const url = new URL(event.filename || event.target?.src || '', location.origin);
      if (url.origin === location.origin) path = url.pathname; } catch {}
    send({ type: 'diagnostic', code, path, line: Number(event.lineno) || 0 });
  }, true);
  window.addEventListener('unhandledrejection', () => send({ type: 'diagnostic', code: 'unhandled-rejection' }));
  window.addEventListener('securitypolicyviolation', event => {
    const directives = ['script-src', 'script-src-elem', 'connect-src', 'style-src', 'img-src', 'default-src'];
    send({ type: 'diagnostic', code: 'csp', directive: directives.includes(event.effectiveDirective) ? event.effectiveDirective : 'other' });
  });
})();
