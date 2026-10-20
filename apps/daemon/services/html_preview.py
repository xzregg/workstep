"""Bounded, short-lived read-only capabilities for untrusted HTML resources.

Only the authenticated preview API issues a ticket. The resource handler never
accepts a filesystem root, user identity or arbitrary upstream URL from HTML.
All filesystem work and HTML preparation run in the caller's I/O executor.
"""

from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
import secrets
import threading
import time

TTL_SECONDS = 3600
MAX_TICKETS = 256
MAX_RESOURCE_BYTES = 25 * 1024 * 1024
RESOURCE_EXTENSIONS = frozenset('.html .htm .css .js .mjs .json .txt .csv .svg .png .jpg .jpeg .gif .webp .avif .ico .woff .woff2 .ttf .otf .mp3 .mp4 .wav .webm .ogg .pdf .wasm'.split())


@dataclass(frozen=True)
class PreviewTicket:
    project_id: str | None
    root: Path
    expires: float


_tickets: OrderedDict[str, PreviewTicket] = OrderedDict()
_lock = threading.Lock()


class HtmlPreviewError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def issue_ticket(file_path: Path, project_id: str | None) -> dict:
    now = time.monotonic()
    with _lock:
        for key in list(_tickets):
            if _tickets[key].expires <= now:
                del _tickets[key]
        while len(_tickets) >= MAX_TICKETS:
            _tickets.popitem(last=False)
        token = secrets.token_urlsafe(32)
        _tickets[token] = PreviewTicket(project_id, file_path.parent.resolve(), now + TTL_SECONDS)
    return {'token': token, 'entry': file_path.name}


def resource_file(token: str, project_id: str | None, path: str) -> Path:
    with _lock:
        ticket = _tickets.get(token)
    if ticket is None or ticket.expires <= time.monotonic() or ticket.project_id != project_id:
        raise HtmlPreviewError(status_code=404, detail='Preview expired or unavailable')
    candidate = Path(path)
    if candidate.is_absolute() or '\\' in path or any(part.startswith('.') for part in candidate.parts):
        raise HtmlPreviewError(status_code=403, detail='Preview resource denied')
    target = (ticket.root / candidate).resolve()
    if not target.is_relative_to(ticket.root) or target.suffix.lower() not in RESOURCE_EXTENSIONS:
        raise HtmlPreviewError(status_code=403, detail='Preview resource denied')
    if not target.is_file():
        raise HtmlPreviewError(status_code=404, detail='Preview resource unavailable')
    if target.stat().st_size > MAX_RESOURCE_BYTES:
        raise HtmlPreviewError(status_code=413, detail='Preview resource too large')
    return target


def prepare_html(content: str) -> str:
    # Runs before user code. Networking uses the browser's native APIs and the
    # scoped resource ticket; no browser credentials or API adapters are injected.
    bootstrap = r'''<script>
(() => {
  function lightFallback(css) {
    const marker = 'light-dark(';
    let cursor = 0, output = '';
    while (cursor < css.length) {
      const start = css.indexOf(marker, cursor);
      if (start < 0) return output + css.slice(cursor);
      let depth = 0, comma = -1, end = -1;
      for (let i = start + marker.length; i < css.length; i++) {
        if (css[i] === '(') depth++;
        else if (css[i] === ')') { if (depth === 0) { end = i; break; } depth--; }
        else if (css[i] === ',' && depth === 0 && comma < 0) comma = i;
      }
      if (comma < 0 || end < 0) return output + css.slice(cursor);
      output += css.slice(cursor, start) + css.slice(start + marker.length, comma).trim();
      cursor = end + 1;
    }
    return output;
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (!CSS.supports('color', 'light-dark(white, black)')) {
      // Legacy WebViews still render a usable light palette.
      document.querySelectorAll('style').forEach(style => {
        style.textContent = lightFallback(style.textContent || '');
      });
    }
  });
})();
</script>'''
    # Preserve doctype/quirks mode. Insert before any attacker-controlled markup.
    import re
    doctype = re.match(r'[\s\ufeff]*<!doctype[^>]*>', content, re.IGNORECASE)
    if doctype:
        return content[:doctype.end()] + bootstrap + content[doctype.end():]
    return bootstrap + content
