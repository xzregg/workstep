"""Identify the bundled voice worker and its bounded WebAssembly asset."""
import re

_VOICE_WORKER = re.compile(r'/assets/(?:voiceDsp|wakeWord)\.worker-[A-Za-z0-9_-]+\.js')
_VOICE_WASM = re.compile(r'/assets/(?:ort-wasm-simd-threaded|kws)-[A-Za-z0-9_-]+\.wasm')


def is_voice_worker(path: str, status: int, content_type: str) -> bool:
    return (status == 200 and content_type.split(';', 1)[0] in ('text/javascript', 'application/javascript')
            and _VOICE_WORKER.fullmatch(path) is not None)


def is_voice_wasm(path: str) -> bool:
    return _VOICE_WASM.fullmatch(path) is not None
