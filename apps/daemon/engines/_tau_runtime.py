"""Strict stream completion and request deadlines around the official Tau SDK."""
import asyncio
from contextlib import aclosing
import json
import httpx


class SSECompletion:
    def __init__(self):
        self.pending = b''
        self.data = []
        self.completed = False

    def feed(self, chunk):
        self.pending += chunk
        while b'\n' in self.pending:
            line, self.pending = self.pending.split(b'\n', 1)
            self.line(line.rstrip(b'\r'))
        if len(self.pending) > 4 * 1024 * 1024:
            raise RuntimeError('Tau provider SSE line exceeded 4 MiB')

    def line(self, line):
        if line.startswith(b'data:'):
            self.data.append(line[5:].lstrip())
        elif not line and self.data:
            data, self.data = b'\n'.join(self.data), []
            if data == b'[DONE]':
                if not self.completed:
                    raise RuntimeError('Tau provider stream terminated without a completion reason')
                return
            try:
                event = json.loads(data)
            except (ValueError, UnicodeDecodeError) as exc:
                raise RuntimeError('Tau provider returned invalid SSE JSON') from exc
            if not isinstance(event, dict):
                raise RuntimeError('Tau provider returned invalid SSE event')
            kind = event.get('type', '')
            if event.get('error') or kind in {'error', 'response.failed', 'response.incomplete'}:
                raise RuntimeError('Tau provider reported an error or incomplete response')
            if kind in {'response.completed', 'message_stop'}:
                self.completed = True
            for choice in event.get('choices') or []:
                reason = choice.get('finish_reason')
                if reason in {'length', 'content_filter'}:
                    raise RuntimeError('Tau provider output was truncated by a limit or filter')
                if reason is not None:
                    if reason not in {'stop', 'tool_calls', 'function_call'}:
                        raise RuntimeError('Tau provider returned an unsupported completion reason')
                    self.completed = True
            if kind == 'message_delta':
                reason = (event.get('delta') or {}).get('stop_reason')
                if reason in {'max_tokens', 'refusal'}:
                    raise RuntimeError('Tau provider output was truncated by a limit or filter')

    def finish(self):
        if self.pending:
            self.line(self.pending.rstrip(b'\r'))
            self.pending = b''
        self.line(b'')
        if not self.completed:
            raise RuntimeError('Tau provider stream ended before completion')


class CheckedStream(httpx.AsyncByteStream):
    def __init__(self, stream):
        self.stream = stream

    async def __aiter__(self):
        check = SSECompletion()
        async for chunk in self.stream:
            check.feed(chunk)
            yield chunk
        check.finish()

    async def aclose(self):
        await self.stream.aclose()


async def guard_response(response):
    if response.status_code >= 400:
        return  # Preserve the SDK's HTTP error handling and retry policy.
    if response.headers.get('content-type', '').split(';', 1)[0].strip() != 'text/event-stream':
        raise RuntimeError('Tau provider expected text/event-stream')
    if response.is_stream_consumed:
        check = SSECompletion()
        check.feed(response.content)
        check.finish()
    else:
        response.stream = CheckedStream(response.stream)


async def checked_provider_stream(provider, timeout, **kwargs):
    try:
        async with asyncio.timeout(timeout):
            async with aclosing(provider.stream_response(**kwargs)) as stream:
                terminal = False
                async for event in stream:
                    if event.type == 'done':
                        terminal = True
                        if event.reason == 'length':
                            raise RuntimeError('Tau provider output was truncated by a token limit')
                        if not event.message.text.strip() and not event.message.tool_calls:
                            raise RuntimeError('Tau provider returned an empty reply')
                    elif event.type == 'error':
                        terminal = True
                    yield event
                if not terminal:
                    raise RuntimeError('Tau provider stream ended before completion')
    except TimeoutError as exc:
        raise TimeoutError(f'Tau model request timed out after {timeout:g} seconds') from exc


class CheckedProvider:
    def __init__(self, provider, timeout):
        self.provider, self.timeout = provider, timeout

    def stream_response(self, **kwargs):
        return checked_provider_stream(self.provider, self.timeout, **kwargs)
