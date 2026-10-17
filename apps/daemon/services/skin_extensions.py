"""Version-two skin configuration and CSS compilation (called in skin I/O threads)."""
import re
from pathlib import PurePosixPath

import tinycss2

CONFIG_KEYS = {'tokens', 'styles', 'layout', 'desktop', 'mobile', 'menus', 'effects'}
FILE_TYPES = {'.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
              '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2'}


def validate_extensions(document):
    effects = document.get('effects', {})
    if not isinstance(effects, dict) or set(effects) - {'reveal', 'charsPerSecond', 'maxDurationMs'}:
        raise ValueError('消息动效配置无效')
    for name, value in effects.items():
        if name == 'reveal':
            if not isinstance(value, bool):
                raise ValueError('吐字开关无效')
        elif isinstance(value, bool) or not isinstance(value, (int, float)) or not (10 <= value <= (1000 if name == 'charsPerSecond' else 10000)):
            raise ValueError('吐字参数超出范围')
    menus = document.get('menus', [])
    if not isinstance(menus, list) or len(menus) > 16:
        raise ValueError('菜单配置无效')
    ids = set()
    for menu in menus:
        if not isinstance(menu, dict) or set(menu) - {'id', 'label', 'position', 'items'}:
            raise ValueError('菜单配置字段无效')
        if not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', str(menu.get('id', ''))) or menu['id'] in ids:
            raise ValueError('菜单 ID 无效或重复')
        ids.add(menu['id'])
        if not isinstance(menu.get('label'), str) or not 1 <= len(menu['label'].strip()) <= 100 or menu.get('position', 'right') not in {'top', 'bottom', 'left', 'right'}:
            raise ValueError('菜单名称或位置无效')
        items = menu.get('items')
        if not isinstance(items, list) or not 1 <= len(items) <= 64:
            raise ValueError('菜单项无效')
        for item in items:
            if not isinstance(item, dict) or set(item) - {'label', 'action', 'args'} or not all(isinstance(item.get(key), str) and 0 < len(item[key].strip()) <= 100 for key in ('label', 'action')) or not isinstance(item.get('args', {}), dict):
                raise ValueError('菜单动作无效')


def compile_css(source, skin_id, revision, files):
    """Scope ordinary selectors; keep keyframe steps intact and resolve local URLs."""
    scope = f'html[data-skin-id="{skin_id}"]'
    base = f'/api/skins/files/{revision}'
    rules = tinycss2.parse_stylesheet(source, skip_comments=True, skip_whitespace=True)
    animation_names = {}

    def collect(nodes):
        for rule in nodes:
            if rule.type == 'error':
                raise ValueError('CSS 语法无效')
            if rule.type == 'at-rule' and rule.lower_at_keyword in {'keyframes', '-webkit-keyframes'}:
                name = tinycss2.serialize(rule.prelude).strip()
                if not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_-]*', name) or name in {'none', 'initial', 'inherit', 'linear', 'ease', 'infinite', 'normal', 'reverse', 'alternate', 'both', 'forwards', 'backwards', 'running', 'paused'}:
                    raise ValueError('动画名称无效')
                animation_names[name] = f'{skin_id}-{name}'
            elif rule.type == 'at-rule' and rule.content is not None and rule.lower_at_keyword in {'media', 'supports', 'container', 'layer'}:
                collect(tinycss2.parse_rule_list(rule.content, skip_whitespace=True, skip_comments=True))
    collect(rules)

    def asset(value):
        path = PurePosixPath(value)
        if not value.startswith('assets/') or not re.fullmatch(r'assets/[A-Za-z0-9_./-]+', value) or '..' in path.parts or value not in files:
            raise ValueError('CSS 只能引用包内存在的 assets 资源')
        return f'url("{base}/{value}")'

    def values(tokens, animations=False):
        result = []
        for token in tokens:
            if token.type == 'error':
                raise ValueError('CSS 属性语法无效')
            if token.type == 'url':
                result.append(asset(token.value))
            elif token.type == 'function':
                if token.lower_name == 'url':
                    args = [item for item in token.arguments if item.type != 'whitespace']
                    if len(args) != 1 or args[0].type != 'string':
                        raise ValueError('CSS 资源地址无效')
                    result.append(asset(args[0].value))
                else:
                    result.append(f'{token.name}({values(token.arguments, animations)})')
            elif animations and token.type == 'ident' and token.value in animation_names:
                result.append(animation_names[token.value])
            else:
                result.append(tinycss2.serialize([token]))
        return ''.join(result)

    def declarations(tokens):
        output = []
        for declaration in tinycss2.parse_declaration_list(tokens, skip_whitespace=True, skip_comments=True):
            if declaration.type != 'declaration':
                raise ValueError('CSS 声明无效，不支持嵌套选择器')
            value = values(declaration.value, declaration.lower_name in {'animation', 'animation-name', '-webkit-animation', '-webkit-animation-name'} or declaration.name.startswith('--'))
            output.append(f'{declaration.name}:{value}{" !important" if declaration.important else ""};')
        return ''.join(output)

    def selectors(tokens):
        groups = [[]]
        for token in tokens:
            if token.type == 'literal' and token.value == ',':
                groups.append([])
            else:
                groups[-1].append(token)
        output = []
        for group in groups:
            selector = tinycss2.serialize(group).strip()
            if not selector:
                raise ValueError('CSS 选择器无效')
            if selector.startswith(':root'):
                selector = scope + selector[5:]
            elif re.match(r'^html(?=$|[\s.#:\[])', selector):
                selector = scope + selector[4:]
            else:
                selector = scope + ' ' + selector
            output.append(selector)
        return ','.join(output)

    def render(nodes, keyframes=False):
        output = []
        for rule in nodes:
            if rule.type == 'qualified-rule':
                prelude = tinycss2.serialize(rule.prelude) if keyframes else selectors(rule.prelude)
                output.append(f'{prelude}{{{declarations(rule.content)}}}')
            elif rule.type == 'at-rule':
                name = rule.lower_at_keyword
                if rule.content is None:
                    raise ValueError('不支持 CSS 外部导入或无内容指令')
                if name in {'keyframes', '-webkit-keyframes'}:
                    prelude = animation_names[tinycss2.serialize(rule.prelude).strip()]
                    content = render(tinycss2.parse_rule_list(rule.content, skip_comments=True, skip_whitespace=True), True)
                elif name in {'media', 'supports', 'container', 'layer'}:
                    prelude = values(rule.prelude)
                    content = render(tinycss2.parse_rule_list(rule.content, skip_comments=True, skip_whitespace=True))
                elif name == 'font-face':
                    prelude = ''
                    content = declarations(rule.content)
                else:
                    raise ValueError(f'不支持 CSS @{name}')
                output.append(f'@{name} {prelude}{{{content}}}')
            else:
                raise ValueError('CSS 语法无效')
        return '\n'.join(output)
    return render(rules)
