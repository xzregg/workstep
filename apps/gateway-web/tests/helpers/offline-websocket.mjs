// Unit tests must never open network connections. A transport test installs its own fake.
globalThis.WebSocket = class OfflineWebSocket {
  readyState = 3
  close() {}
  send() {}
}
