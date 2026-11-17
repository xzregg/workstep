"""Route server requests without parking the SDK's sole stdout reader.

The installed SDK synchronously writes the return value of
``_handle_server_request``. Defer that one response and write it when the
thread-scoped async handler finishes; all other transport writes are unchanged.
"""
import asyncio
from contextlib import suppress
from concurrent.futures import ThreadPoolExecutor
import threading


def deny_request(method, params=None):
    if method == 'item/tool/requestUserInput':
        return {'answers': {}}
    if method == 'mcpServer/elicitation/request':
        return {'action': 'cancel', 'content': None, '_meta': None}
    return {'decision': 'deny'}


class CodexApprovalRouter:
    def __init__(self, client, on_failure=None):
        self.loop = asyncio.get_running_loop()
        self.routes = {}
        self.pending = {}
        self.lock = threading.Lock()
        self.start_lock = threading.Lock()
        # SDK notification iterators may occupy the loop's entire default
        # executor. A user's approval must still be able to write its reply.
        self.response_executor = ThreadPoolExecutor(max_workers=1,thread_name_prefix='codex-approval-write')
        self.closed = False
        sync = getattr(getattr(client, '_client', None), '_sync', None)
        if sync is None or not hasattr(sync, '_approval_handler'):
            raise RuntimeError('当前 openai-codex SDK 不支持 WorkStep 审批桥接')
        self.sync = sync
        start = getattr(sync, 'start', None)
        if callable(start):
            def start_native():
                with self.start_lock:
                    if self.closed:
                        raise RuntimeError('Codex 客户端已关闭')
                    start()
            sync.start = start_native
        native_router = getattr(sync, '_router', None)
        if native_router is not None and on_failure is not None:
            fail_all = native_router.fail_all
            def notify_failure():
                if not self.closed:
                    on_failure()
            def transport_failed(exc):
                try:
                    fail_all(exc)
                finally:
                    if self._can_schedule():
                        try:
                            self.loop.call_soon_threadsafe(notify_failure)
                        except RuntimeError:
                            # The loop may close after the availability check.
                            if not self.loop.is_closed():
                                raise
            native_router.fail_all = transport_failed
        sync._approval_handler = self.dispatch_sync
        # In-process test peers can call the synchronous dispatcher directly.
        # Real SDK clients must expose both seams, never partially patch one.
        handle = getattr(sync, '_handle_server_request', None)
        write = getattr(sync, '_write_message', None)
        if callable(handle) != callable(write) or (hasattr(sync, '_proc') and not callable(handle)):
            raise RuntimeError('当前 openai-codex SDK 不支持非阻塞审批桥接')
        if callable(handle):
            self.write = write
            deferred = object()

            def receive(request):
                method, params = request['method'], request.get('params') or {}
                with self.lock:
                    if not self._can_schedule():
                        return deny_request(method, params)
                    route = self.routes.get(params.get('threadId') or params.get('thread_id'))
                    response = self.respond(request['id'], method, params, route)
                    try:
                        future = asyncio.run_coroutine_threadsafe(response, self.loop)
                    except RuntimeError:
                        response.close()
                        if self.loop.is_closed():
                            return deny_request(method, params)
                        raise
                    self.pending[future] = route
                future.add_done_callback(self.finished)
                return deferred

            def send(message):
                if message.get('result') is not deferred:
                    write(message)

            sync._handle_server_request = receive
            sync._write_message = send

    def _can_schedule(self):
        return not self.closed and not self.loop.is_closed() and self.loop.is_running()

    def wait_startup(self):
        """Run off-loop before closing: Popen may still be in a SDK worker."""
        with self.start_lock:
            pass

    def background_threads(self):
        # submit() registers new executor threads synchronously on this loop;
        # close() prevents further submissions before the pool snapshots them.
        return set(self.response_executor._threads)

    def bind(self, thread_id, owner, handler):
        with self.lock:
            self.routes[thread_id] = (owner, handler)

    def unbind(self, owner):
        with self.lock:
            self.routes = {k:v for k,v in self.routes.items() if v[0] is not owner}
            pending = [f for f,r in self.pending.items() if r is not None and r[0] is owner]
        for f in pending:
            f.cancel()

    def dispatch_sync(self, method, params):
        params = params or {}
        with self.lock:
            route = self.routes.get(params.get('threadId') or params.get('thread_id'))
        return route[1](method, params) if route else deny_request(method, params)

    async def respond(self, request_id, method, params, route):
        result = deny_request(method, params)
        try:
            if route is not None and not self.closed:
                callback = getattr(route[1], 'async_handler', None)
                async with asyncio.timeout(300):
                    result = (await callback(method, params) if callback is not None
                              else await asyncio.to_thread(route[1], method, params))
                with self.lock:
                    current = self.routes.get(params.get('threadId') or params.get('thread_id'))
                if current is not route:
                    result = deny_request(method, params)
        except (asyncio.CancelledError, Exception):
            result = deny_request(method, params)
        if not self.closed:
            with suppress(Exception):
                await self.loop.run_in_executor(self.response_executor,self.write,
                                               {'id': request_id, 'result': result})

    def finished(self, future):
        with self.lock:
            self.pending.pop(future, None)
        if not future.cancelled():
            future.exception()

    def close(self):
        self.closed = True
        self.response_executor.shutdown(wait=False,cancel_futures=True)
        with self.lock:
            pending = list(self.pending)
            self.routes.clear()
        for future in pending:
            future.cancel()
