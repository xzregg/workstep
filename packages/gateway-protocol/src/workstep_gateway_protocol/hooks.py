"""The only anonymous HTTP route allowed through the device tunnel."""
import logging
import re

HOOK_PATH = re.compile(r'/api/hook/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}\Z')
MAX_HOOK_BODY = 1024 * 1024


class HookAccessLogFilter(logging.Filter):
    def filter(self, record):
        # Uvicorn interpolates the full query string from args[2]. Remove it
        # altogether for hooks so tokens/title/creator never enter access logs.
        if isinstance(record.args, tuple) and len(record.args) == 5:
            path = record.args[2]
            if isinstance(path, str) and HOOK_PATH.fullmatch(path.split('?', 1)[0]):
                args = list(record.args)
                args[2] = path.split('?', 1)[0]
                record.args = tuple(args)
        return True


def install_hook_log_filter():
    logger = logging.getLogger('uvicorn.access')
    if not any(isinstance(f, HookAccessLogFilter) for f in logger.filters):
        logger.addFilter(HookAccessLogFilter())
