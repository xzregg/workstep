"""Versioned source-range edits. Never serialize a browser DOM back to disk."""
from dataclasses import dataclass
from hashlib import sha256
from html import escape, unescape
from html.parser import HTMLParser
import re
import tinycss2
from bisect import bisect_right


class SourceConflict(ValueError):
    pass


@dataclass
class SourceNode:
    id: str
    tag: str
    start: int
    opening_end: int
    closing_start: int | None = None
    end: int | None = None
    children: bool = False


VOID = frozenset('area base br col embed hr img input link meta param source track wbr'.split())
PROPERTIES = frozenset(('color', 'background-color', 'font-size', 'font-weight', 'border-radius',
    'width', 'height', 'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
    'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom'))


# Consume whole attributes so attribute-looking text inside a quoted value is
# never mistaken for a real style or editor marker.
ATTRIBUTE = re.compile(r"""\s+([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?""")


def attributes(opening):
    start = re.match(r'<[^\s/>]+', opening)
    return list(ATTRIBUTE.finditer(opening, start.end() if start else 0))


class HtmlSource(HTMLParser):
    def __init__(self, source: str):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.version = sha256(source.encode()).hexdigest()
        self.nodes: dict[str, SourceNode] = {}
        self.stack: list[SourceNode] = []
        self.lines = [0]
        self.lines.extend(match.end() for match in re.finditer('\n', source))
        self.feed(source)
        self.close()

    def source_offset(self):
        line, column = self.getpos()
        return self.lines[line - 1] + column

    def handle_starttag(self, tag, attrs):
        if self.stack:
            self.stack[-1].children = True
        start = self.source_offset()
        node = SourceNode(f'n{len(self.nodes) + 1}', tag, start, start + len(self.get_starttag_text()))
        self.nodes[node.id] = node
        if tag in VOID:
            node.closing_start = node.end = node.opening_end
        else:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if self.stack and self.stack[-1].start == self.source_offset():
            node = self.stack.pop()
            node.closing_start = node.end = node.opening_end

    def handle_comment(self, data):
        if self.stack:
            self.stack[-1].children = True

    def handle_endtag(self, tag):
        if not self.stack:
            return
        # Ambiguous/malformed markup is previewable but not directly editable.
        if self.stack[-1].tag != tag:
            self.stack.clear()
            return
        node = self.stack.pop()
        node.closing_start = self.source_offset()
        end = self.source.find('>', node.closing_start)
        node.end = end + 1 if end >= 0 else None

    def preview(self):
        result = []
        cursor = 0
        for node in self.nodes.values():
            result.append(self.source[cursor:node.start])
            opening = self.source[node.start:node.opening_end]
            for attr in reversed(attributes(opening)):
                if attr.group(1).lower() == 'data-ws-node':
                    opening = opening[:attr.start()] + opening[attr.end():]
            position = len(opening) - (2 if opening.endswith('/>') else 1)
            result.append(opening[:position] + f' data-ws-node="{node.id}"' + opening[position:])
            cursor = node.opening_end
        result.append(self.source[cursor:])
        return ''.join(result)

    def context(self, node_id: str):
        node = self.nodes.get(node_id)
        if node is None:
            raise ValueError('元素已失效，请重新选择')
        editable = node.end is not None and node.tag not in {'html', 'body', 'head', 'script', 'style'}
        text_editable = editable and not node.children and node.tag not in VOID
        text_value = unescape(self.source[node.opening_end:node.closing_start]) if text_editable else ''
        return {'node_id': node.id, 'tag': node.tag, 'version': self.version,
                'line': bisect_right(self.lines, node.start),
                'source': self.source[node.start:min(node.end or node.opening_end, node.start + 12000)],
                'editable': editable, 'text_editable': text_editable, 'text_value': text_value}

    def edit(self, node_id: str, operation: str, values: dict, version: str):
        if version != self.version:
            raise SourceConflict('文件已更新，请重新选择元素')
        node = self.nodes.get(node_id)
        if node is None or node.end is None or node.tag in {'html', 'head', 'body', 'script', 'style'}:
            raise ValueError('此元素不能直接编辑，请通过评论修改')
        start, end = node.start, node.end
        if operation == 'delete':
            replacement = ''
        elif operation == 'text':
            if node.children or node.tag in VOID:
                raise ValueError('请选择具体文字元素，不能覆盖嵌套结构')
            start, end = node.opening_end, node.closing_start
            replacement = escape(str(values.get('text', '')), quote=False)
        elif operation == 'style':
            if not values or not set(values) <= PROPERTIES:
                raise ValueError('不支持的样式属性')
            for value in values.values():
                if not isinstance(value, str) or len(value) > 100 or re.search(r'[;{}<>\\]|url\s*\(|expression\s*\(|!important', value, re.I):
                    raise ValueError('样式值无效')
            opening = self.source[node.start:node.opening_end]
            matches = [attr for attr in attributes(opening) if attr.group(1).lower() == 'style']
            if len(matches) > 1:
                raise ValueError('重复 style 属性，请通过评论修改')
            match = matches[0] if matches else None
            style = unescape((match.group(2) or '').strip('"\'')) if match else ''
            parsed = tinycss2.parse_declaration_list(style, skip_whitespace=True)
            if any(part.type == 'error' for part in parsed):
                raise ValueError('现有内联样式无法安全解析，请通过评论修改')
            declarations = [tinycss2.serialize([part]).rstrip(';') for part in parsed
                            if not (part.type == 'declaration' and part.lower_name in values)]
            declarations.extend(f'{key}: {value.strip()}' for key, value in values.items() if value.strip())
            attribute = ' style="' + escape('; '.join(declarations), quote=True) + '"'
            if match:
                replacement = opening[:match.start()] + attribute + opening[match.end():]
            else:
                position = len(opening) - (2 if opening.endswith('/>') else 1)
                replacement = opening[:position] + attribute + opening[position:]
            end = node.opening_end
        else:
            raise ValueError('不支持的编辑操作')
        return self.source[:start] + replacement + self.source[end:]
