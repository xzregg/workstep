"""Own login sessions without knowing any vendor's authentication protocol."""
import asyncio

from engines.core.login import EngineLoginSession


class EngineLoginManager:
    def __init__(self):
        self.sessions: dict[str, EngineLoginSession] = {}
        self._lock = asyncio.Lock()

    def status(self, engine_id):
        session = self.sessions.get(engine_id)
        return session.snapshot() if session else None

    async def start(self, engine_id, engine):
        async with self._lock:
            old = self.sessions.get(engine_id)
            if old and old.state.active:
                return old.snapshot()
            if old:
                await old.cancel()
            if not engine.SUPPORTS_LOGIN:
                raise ValueError('This engine does not support interactive login')
            session = await asyncio.to_thread(engine.create_login_session)
            self.sessions[engine_id] = session
            try:
                await session.start()
            except BaseException:
                await session.cancel()
                raise
            return session.snapshot()

    def _current(self, engine_id, session_id):
        session = self.sessions.get(engine_id)
        if not session or session.state.id != session_id:
            raise ValueError('Login session expired; start again')
        return session

    async def submit(self, engine_id, session_id, code):
        async with self._lock:
            session = self._current(engine_id, session_id)
            await session.submit(code)
            return session.snapshot()

    async def cancel(self, engine_id, session_id):
        async with self._lock:
            session = self._current(engine_id, session_id)
            await session.cancel()
            return session.snapshot()

    async def shutdown(self):
        async with self._lock:
            await asyncio.gather(*(session.cancel() for session in self.sessions.values()))
            self.sessions.clear()


login_manager = EngineLoginManager()
