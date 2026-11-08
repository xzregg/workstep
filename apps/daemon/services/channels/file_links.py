"""Convert local Markdown links only at the channel delivery boundary.

No filesystem probing or public grants: the existing preview page authenticates
the reader and the file API enforces the real filesystem boundary on access.
"""
import asyncio
import logging
import ntpath
import posixpath
import re
import threading
from urllib.parse import unquote, urlencode, urlsplit

logger = logging.getLogger(__name__)
_UNSET = object()
_SCHEME = re.compile(r'^[a-z][a-z\d+.-]*:', re.I)
_DRIVE = re.compile(r'^[a-z]:[/\\]', re.I)
_DESTINATION = re.compile(r'^\s*(?:<([^>]*)>|(\S+?))(?:\s+[\"\'].*)?\s*$', re.S)
_FENCE = re.compile(r' {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)')
_BACKTICKS = re.compile(r'`+')


def base_addresses():
    # Lazy import: this helper reads existing configuration, never the network.
    from services.notification_hooks import base_addresses as load
    return load()


def _closing(text, start, opening, closing):
    depth, cursor = 1, start + 1
    angle = False
    while cursor < len(text):
        char = text[cursor]
        if char == '\\' and cursor + 1 < len(text) and text[cursor + 1] in '[]()<>':
            cursor += 2
            continue
        if opening == '(' and char == '<':
            angle = True
        elif opening == '(' and char == '>':
            angle = False
        elif not angle:
            if char == opening:
                depth += 1
            elif char == closing:
                depth -= 1
                if not depth:
                    return cursor
        cursor += 1
    return None


class ChannelFileLinks:
    def __init__(self, project, *, base_url=_UNSET):
        self.project_id = getattr(project, 'id', '')
        self.root = str(getattr(project, 'path', '')).replace('\\', '/')
        self.base_url = base_url
        self._last_progress = ''
        self._lock = threading.Lock()

    async def send_progress(self, send, text):
        converted = await self.convert(text, streaming=True)
        if converted and converted != self._last_progress:
            await send(converted)
            self._last_progress = converted

    async def convert(self, text: str, *, streaming=False) -> str:
        if '[' not in text:
            return text
        # Config and path setup may perform disk I/O; keep them off the event loop.
        return await asyncio.to_thread(self._convert, text, streaming)

    def _convert(self, text, streaming):
        # Cancelling a stream does not stop its worker. Final delivery must wait
        # for that worker's address setup instead of observing partial state.
        with self._lock:
            return self._render_snapshot(text, streaming)

    def _render_snapshot(self, text, streaming):
        if self.base_url is _UNSET:
            self.base_url = ''
            try:
                addresses = base_addresses()
                for kind in ('gateway', 'external', 'internal'):
                    for address in addresses:
                        base = address.get('task_base_url') or ''
                        parsed = urlsplit(base)
                        if (address.get('kind') == kind and parsed.scheme in ('http', 'https')
                                and parsed.hostname and not parsed.username and not parsed.password
                                and not parsed.query and not parsed.fragment):
                            self.base_url = base.rstrip('/')
                            break
                    if self.base_url:
                        break
            except Exception:
                # A configuration failure must not abort an otherwise valid reply.
                logger.warning('Channel preview address unavailable; using file labels')
        return self.render(text, streaming=streaming)

    def _target(self, destination):
        match = _DESTINATION.fullmatch(destination)
        if not match:
            return ''
        path = match[1] if match[1] is not None else match[2]
        if path.startswith(('#', '//')):
            return None
        if path.lower().startswith('file://'):
            try:
                parsed = urlsplit(path)
            except ValueError:
                return ''
            if parsed.netloc not in ('', 'localhost'):
                return ''
            path = parsed.path + ('#' + parsed.fragment if parsed.fragment else '')
            if re.match(r'^/[a-z]:/', path, re.I):
                path = path[1:]
        elif _SCHEME.match(path) and not _DRIVE.match(path):
            return None
        location = re.search(r'(?:#L(\d+)(?:C\d+)?|:(\d+)(?::\d+)?)$', path, re.I)
        digits = (location[1] or location[2]) if location else ''
        line = int(digits) if digits and len(digits) < 10 else None
        if location:
            path = path[:location.start()]
        path = unquote(path.split('?', 1)[0].split('#', 1)[0])
        path = re.sub(r'\\([\[\]()<>])', r'\1', path).replace('\\', '/')
        if not self.root or not self.project_id or path.startswith('~') or '\0' in path:
            return ''
        windows = bool(_DRIVE.match(self.root))
        paths = ntpath if windows else posixpath
        if bool(_DRIVE.match(path)) and not windows:
            return ''
        target = paths.normpath(paths.join(self.root, path))
        try:
            if paths.normcase(paths.commonpath([self.root, target])) != paths.normcase(paths.normpath(self.root)):
                return ''
            relative = paths.relpath(target, self.root).replace('\\', '/')
        except ValueError:
            return ''
        if relative == '.' or not self.base_url or self.base_url is _UNSET:
            return ''
        params = {'project_id': self.project_id, 'path': relative}
        if line:
            params['line'] = str(line)
        return self.base_url.rstrip('/') + '/file-preview?' + urlencode(params)

    def _label(self, label):
        plain = label.strip('` ').replace('\\', '/')
        if plain.startswith(('/', '~', 'file://')) or _DRIVE.match(plain):
            return plain.rstrip('/').rsplit('/', 1)[-1].replace('[', '\\[').replace(']', '\\]')
        return label

    def render(self, text: str, *, streaming=False) -> str:
        output, cursor = [], 0
        while cursor < len(text):
            # Preserve code examples, including unfinished fenced/inline code.
            fence = _FENCE.match(text, cursor) if cursor == 0 or text[cursor - 1] == '\n' else None
            if fence:
                marker = fence[1]
                end = re.compile(r'(?m)^ {0,3}' + re.escape(marker[0]) + '{' + str(len(marker)) + r',}[ \t]*(?:\n|$)').search(text, fence.end())
                stop = end.end() if end else len(text)
                output.append(text[cursor:stop]); cursor = stop
                continue
            if text[cursor] == '`':
                marker = _BACKTICKS.match(text, cursor)[0]
                end = text.find(marker, cursor + len(marker))
                stop = end + len(marker) if end >= 0 else len(text)
                output.append(text[cursor:stop]); cursor = stop
                continue
            if text[cursor] == '\\' and cursor + 1 < len(text):
                output.append(text[cursor:cursor + 2]); cursor += 2
                continue
            image = text.startswith('![', cursor)
            start = cursor + 1 if image else cursor
            if text[start] != '[':
                output.append(text[cursor]); cursor += 1
                continue
            end = _closing(text, start, '[', ']')
            if end is None:
                if not streaming:
                    label = text[start + 1:]
                    safe_label = self._label(label)
                    output.append(text[cursor:] if safe_label == label else safe_label)
                break
            label = text[start + 1:end]
            if end + 1 == len(text) and streaming:
                break
            if (text[end + 1:end + 2] == ':' and not image
                    and text[text.rfind('\n', 0, cursor) + 1:cursor].strip() == ''):
                close = text.find('\n', end + 2)
                if close < 0:
                    if streaming:
                        break
                    close = len(text)
                target = self._target(text[end + 2:close])
                if target is None:
                    output.append(text[cursor:close])
                elif target:
                    output.append(f'[{self._label(label)}]: {target}')
                else:
                    output.append(self._label(label))
                cursor = close
                continue
            if text[end + 1:end + 2] != '(':
                output.append(text[cursor:end + 1]); cursor = end + 1
                continue
            close = _closing(text, end + 1, '(', ')')
            if close is None:
                if not streaming:
                    output.append(self._label(label))
                break
            target = self._target(text[end + 2:close])
            if target is None:
                output.append(text[cursor:close + 1])
            else:
                label = self._label(label)
                output.append(f'[{label}]({target})' if target else label)
            cursor = close + 1
        return ''.join(output)
