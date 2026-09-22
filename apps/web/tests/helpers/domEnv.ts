import { Window } from 'happy-dom'

/* happy-dom bootstrap for component tests.

   react-dom snapshots `canUseDOM` (and therefore which DOM events back
   onChange) the first time it is evaluated, so a DOM must already exist before
   `react-dom/client` is imported. Test files therefore import this module
   FIRST — ESM evaluates imports in order — and may call
   `installDomEnvironment()` again per test for a fresh window. */

export interface DomEnvironment {
  window: Window
  document: Document
}

export function installDomEnvironment(): DomEnvironment {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Event: window.Event,
    InputEvent: window.InputEvent,
    CompositionEvent: window.CompositionEvent,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    FocusEvent: window.FocusEvent,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLInputElement: window.HTMLInputElement,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => window.clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return { window, document: window.document as unknown as Document }
}

// Installed at import time so react-dom detects a DOM environment.
export const domEnvironment = installDomEnvironment()
