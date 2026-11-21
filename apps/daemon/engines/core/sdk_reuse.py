"""Session leases for the bidirectional Claude/Qoder Python SDK clients."""
import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

from engines.core.process_cleanup import close_sdk_client, sdk_process
from engines.core.session_pool import ManagedConnection, get_session_pool, startup_fingerprint


class PooledSDKClient:
    def __init__(self, engine, factory, options, cwd, session_id):
        self.engine, self.factory, self.options = engine, factory, options
        self.cwd, self.session_id = cwd, session_id
        self.pool = get_session_pool(engine.ENGINE_ID)
        self.lease = None
        self.native = None
        self.end = asyncio.Event()
        self.completed = False
        self.failed = False
        self.inflight = 0
        self.inputs_sent = 0
        self.end_requested = False

    def __getattr__(self, name):
        if name in {'_client', '_transport'}:
            raise AttributeError(name)
        return getattr(self.native, name)

    async def connect(self):
        previous = self.pool._entries.get((self.cwd, self.session_id))
        if previous is not None and not getattr(self.options, 'system_prompt', None):
            value = previous.client.value
            if value is not None:
                self.options.system_prompt = getattr(value.options, 'system_prompt', None)
        values = vars(self.options)
        routes = {key: value for key, value in values.items() if callable(value)}
        settings = {key: value for key, value in values.items() if key != 'resume' and key not in routes}
        settings['callback_names'] = sorted(routes)
        fingerprint = await asyncio.to_thread(startup_fingerprint, settings)
        @asynccontextmanager
        async def context():
            callbacks = dict(routes)
            for name in routes:
                if name == 'stderr':
                    def stderr(line):
                        callback = callbacks.get('stderr')
                        if callback:
                            callback(line)
                    setattr(self.options, name, stderr)
                else:
                    def make_callback(key):
                        async def invoke(*args, **kwargs):
                            callback = callbacks.get(key)
                            if callback is None:
                                raise RuntimeError('No active request in the current SDK session')
                            return await callback(*args, **kwargs)
                        return invoke
                    setattr(self.options, name, make_callback(name))
            native = self.factory(options=self.options)
            try:
                await native.connect()
                yield SimpleNamespace(native=native, process=sdk_process(native), routes=callbacks,
                                      options=self.options)
            finally:
                callbacks.clear()
                await close_sdk_client(native)
        self.lease = await self.pool.acquire(self.cwd, self.session_id, fingerprint,
                                             lambda: ManagedConnection(context))
        try:
            value = await self.lease.client.open()
            value.routes.update(routes)
            self.native = value.native
            self.lease.on_close = self.cancel_interactions
        except BaseException:
            await self.pool.discard(self.lease)
            raise

    def cancel_interactions(self):
        for future in list(getattr(self.engine, '_pending_interaction_responses', {}).values()):
            if not future.done():
                future.cancel()
        self.end.set()

    async def query(self, prompt, *args, **kwargs):
        if isinstance(prompt, str):
            self.inflight = 1
            self.inputs_sent += 1
            return await self.native.query(prompt, *args, **kwargs)
        async def counted():
            async for message in prompt:
                self.inflight = 1
                self.inputs_sent += 1
                yield message
        return await self.native.query(counted(), *args, **kwargs)

    async def receive_messages(self):
        stream = self.native.receive_messages().__aiter__()
        pending = asyncio.create_task(anext(stream))
        end = asyncio.create_task(self.end.wait())
        try:
            while True:
                done, _ = await asyncio.wait({pending, end}, return_when=asyncio.FIRST_COMPLETED)
                if pending in done:
                    try:
                        message = pending.result()
                    except StopAsyncIteration:
                        return
                    kind = self.engine._msg_type(message)
                    data = getattr(message, 'data', {}) or {}
                    sid = getattr(message, 'session_id', None) or data.get('session_id')
                    if sid:
                        self.pool.bind(self.lease, sid, sid)
                    if kind == 'result':
                        # Native runtimes may merge pre-result inputs into one
                        # result. Input count is not a physical-turn count.
                        self.inflight = 0
                        self.completed = True
                        self.failed |= bool(getattr(message, 'is_error', False))
                    yield message
                    if self.end_requested and self.inflight == 0 and self.inputs_sent <= 1:
                        self.end.set()
                    pending = asyncio.create_task(anext(stream))
                elif end in done:
                    return
        finally:
            for task in (pending, end):
                if not task.done():
                    task.cancel()
            await asyncio.gather(pending, end, return_exceptions=True)
            close = getattr(stream, 'aclose', None)
            if close:
                await close()

    async def disconnect(self):
        # The turn watchdog ends this consumer, not the native transport.
        self.end_requested = True
        if self.inputs_sent > 1:
            # No protocol fence identifies whether inserted inputs were merged
            # or queued as separate turns. EOF drains both forms completely;
            # discard this transport afterwards instead of leaking a late
            # response into the next API request.
            transport = getattr(self.native, '_transport', None)
            end_input = getattr(transport, 'end_input', None)
            if end_input is not None:
                await end_input()
            return
        if self.inflight == 0:
            self.end.set()

    async def finish(self, *, reusable):
        if self.lease is not None:
            value = self.lease.client.value
            if value is not None:
                value.routes.clear()
            await self.pool.release(self.lease, reusable=(reusable and self.completed
                                                        and not self.failed and self.inputs_sent <= 1))

    async def abort(self):
        self.cancel_interactions()
        if self.lease is not None:
            await self.pool.discard(self.lease)
