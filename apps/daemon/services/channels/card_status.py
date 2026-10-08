"""Per-reply status data, rendered without I/O or invented usage values.

Template contract reference: soimy/openclaw-channel-dingtalk
src/card/card-template.ts and docs/assets/card-data-mock-v2.json (MIT).
"""
from dataclasses import dataclass, field
import time


def compact(value):
    return f'{value / 1_000_000:.1f}M' if value >= 1_000_000 else f'{value / 1000:.1f}k' if value >= 1000 else str(value)


def execution_header(metadata):
    engine = metadata.get('engine', '')
    if engine in ('codex', 'codex_sdk'):
        engine = 'Codex'
    return ' * '.join(value for value in (engine, metadata.get('model', '')) if value)


@dataclass
class CardStatus:
    metadata: dict = field(default_factory=dict)
    started: float = field(default_factory=lambda: time.monotonic())
    finished: float | None = None
    api_calls: int = 0
    usage: dict = field(default_factory=dict)

    def observe(self, event):
        for key in ('model', 'engine', 'thinking_effort', 'assistant'):
            if isinstance(event.get(key), str) and event[key]:
                self.metadata[key] = event[key]
        if event.get('type') == 'CUSTOM' and event.get('name') == 'workstep.usage':
            data = event.get('value') or {}
            for key in ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cost'):
                value = data.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                    self.usage[key] = value
        if event.get('type') == 'TEXT_MESSAGE_END' and self.finished is None:
            self.finished = time.monotonic()

    def render(self):
        header = execution_header(self.metadata)
        elapsed = int((self.finished if self.finished is not None else time.monotonic()) - self.started)
        duration = f'{elapsed}s' if elapsed < 60 else f'{elapsed // 60}m{elapsed % 60}s'
        details = [duration]
        tokens = []
        if 'input_tokens' in self.usage:
            text = '↑' + compact(self.usage['input_tokens'])
            if self.usage.get('cache_read_input_tokens'):
                text += '(C:' + compact(self.usage['cache_read_input_tokens']) + ')'
            tokens.append(text)
        if 'output_tokens' in self.usage:
            tokens.append('↓' + compact(self.usage['output_tokens']))
        if tokens:
            details.append(' '.join(tokens))
        if self.usage.get('cache_creation_input_tokens'):
            details.append('缓存写入 ' + compact(self.usage['cache_creation_input_tokens']))
        return '\n'.join(filter(None, [header, ' | '.join(details)]))
