"""Collect static prototype dependencies without copying an entire project tree."""
from collections import deque
from html.parser import HTMLParser
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

import tinycss2

EDITABLE = frozenset({'.html', '.htm', '.css', '.js', '.mjs'})
RESOURCES = EDITABLE | {'.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf'}
EXCLUDED = {'node_modules', '.git', '.workstep', '__pycache__', 'dist', 'build', '.venv'}


def css_references(source):
    def visit(tokens):
        for index, token in enumerate(tokens):
            if token.type == 'url':
                yield token.value
            elif token.type == 'function' and token.lower_name == 'url':
                arguments = [part for part in token.arguments if part.type != 'whitespace']
                if len(arguments) == 1 and arguments[0].type == 'string':
                    yield arguments[0].value
            elif token.type == 'at-keyword' and token.value.lower() == 'import':
                following = next((part for part in tokens[index + 1:] if part.type != 'whitespace'), None)
                if following and following.type == 'string':
                    yield following.value
            else:
                yield from visit(getattr(token, 'content', getattr(token, 'arguments', [])))
    yield from visit(tinycss2.parse_component_value_list(source))


# Literal ES imports, dynamic import/require/new URL, and browser fetches.
_MODULE_URL = re.compile(r"(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)['\"]([^'\"\r\n]+)['\"]")
_FETCH_URL = re.compile(r"\bfetch\s*\(\s*['\"]([^'\"\r\n]+)['\"]")


class HtmlReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []
        self.styles = []
        self.scripts = []
        self.section = None

    def handle_starttag(self, tag, attrs):
        self.section = tag if tag in {'style', 'script'} else self.section
        for name, value in attrs:
            if not value:
                continue
            if name in {'src', 'href', 'poster', 'data'}:
                self.urls.append(value)
            elif name in {'srcset', 'imagesrcset'}:
                self.urls.extend(item.strip().split()[0] for item in value.split(',') if item.strip())
            elif name == 'style':
                self.styles.append(value)

    def handle_endtag(self, tag):
        if tag == self.section:
            self.section = None

    def handle_data(self, data):
        if self.section == 'style':
            self.styles.append(data)
        elif self.section == 'script':
            self.scripts.append(data)


def collect_resources(root: Path, entries, *, max_file: int, max_total: int, include_siblings: bool = True):
    """Include sibling pages and their transitive local dependencies, off-loop."""
    queue = deque()
    for entry in entries:
        parent = (root / entry).parent
        queue.append((root / entry, parent))
        if not include_siblings:
            continue
        try:
            siblings = sorted(parent.iterdir())
        except FileNotFoundError:
            continue
        queue.extend((page, parent) for page in siblings if page.suffix.lower() in {'.html', '.htm'})
    paths, seen, contents, total = {}, set(), {}, 0

    def enqueue(raw, base, document_base):
        try:
            url = urlsplit(raw)
        except ValueError:
            return
        if url.scheme or url.netloc or not url.path:
            return
        decoded = unquote(url.path)
        candidate = Path(os.path.abspath(root / decoded.lstrip('/') if decoded.startswith('/') else base / decoded))
        if candidate.is_relative_to(root):
            queue.append((candidate, document_base))

    while queue:
        path, document_base = queue.popleft()
        if not path.is_relative_to(root):
            continue
        relative = path.relative_to(root)
        if any(part in EXCLUDED or part.startswith('.') for part in relative.parts) or path.suffix.lower() not in RESOURCES:
            continue
        key = (path, document_base)
        if key in seen:
            continue
        seen.add(key)
        target = root
        for part in relative.parts:
            target /= part
            if target.is_symlink():
                raise ValueError(f'原型资源不能包含符号链接：{relative.as_posix()}')
        if not path.is_file():
            continue
        if path not in paths:
            size = path.stat().st_size
            total += size
            if size > max_file:
                raise ValueError(f'原型资源超过单文件限制：{relative.as_posix()}（{size / 1024 / 1024:.1f} MiB，上限 {max_file / 1024 / 1024:g} MiB）')
            if total > max_total:
                raise ValueError(f'原型引用资源总量超过 {max_total / 1024 / 1024:g} MiB：{relative.as_posix()}')
            paths[path] = None
        suffix = path.suffix.lower()
        if suffix not in EDITABLE:
            continue
        if path not in contents:
            contents[path] = path.read_bytes().decode('utf-8', errors='replace')
        source = contents[path]
        if suffix in {'.html', '.htm'}:
            document_base = path.parent
            parser = HtmlReferences()
            parser.feed(source)
            for raw in parser.urls:
                enqueue(raw, path.parent, document_base)
            for style in parser.styles:
                for raw in css_references(style):
                    enqueue(raw, path.parent, document_base)
            source = '\n'.join(parser.scripts)
        elif suffix == '.css':
            for raw in css_references(source):
                enqueue(raw, path.parent, document_base)
            continue
        for raw in _MODULE_URL.findall(source):
            enqueue(raw, path.parent, document_base)
        for raw in _FETCH_URL.findall(source):
            enqueue(raw, document_base, document_base)
    return list(paths)
