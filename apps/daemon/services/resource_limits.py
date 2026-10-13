"""Process descriptor limits for desktop and direct daemon startup."""
import logging
import os
import re

try:
    import resource
except ImportError:  # Windows has no POSIX descriptor resource limit.
    resource = None

logger = logging.getLogger(__name__)


def configure_file_limit() -> int | None:
    if resource is None:
        return None
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    requested = os.environ.get("WORKSTEP_NOFILE_LIMIT") or "4096"
    if not re.fullmatch(r"[1-9][0-9]{0,8}", requested):
        logger.warning("Invalid WORKSTEP_NOFILE_LIMIT; keeping descriptor limit %s", soft)
        return soft
    target = int(requested)
    if hard != resource.RLIM_INFINITY:
        target = min(target, hard)
    if soft != resource.RLIM_INFINITY and soft < target:
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
        except (OSError, ValueError):
            logger.warning("Cannot raise descriptor limit; keeping %s", soft)
        else:
            soft = target
    logger.info("File descriptor soft limit: %s (requested %s, hard %s)", soft, requested, hard)
    return soft
