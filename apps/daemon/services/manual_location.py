"""Locate the existing website manual without generating a second copy."""

from pathlib import Path

from settings import settings


def get_manual_location() -> dict:
    """Check readability in the caller's environment; this grants no engine access.

    This synchronous filesystem operation must run in a worker when called from
    async code. Relative website configuration belongs to the daemon directory,
    not the engine's current project directory.
    """
    directory = Path(settings.landing_dist).expanduser()
    if not directory.is_absolute():
        directory = Path(__file__).resolve().parents[1] / directory
    result = {
        "available": False, "directory": str(directory),
        "entry_path": None, "reason": "not_found",
    }
    try:
        directory = directory.resolve()
        result["directory"] = str(directory)
        entry = directory / "index.html"
        if not entry.is_file():
            return result
        # Do not load the multi-megabyte compiled website merely to locate it.
        with entry.open("rb") as source:
            source.read(1)
    except OSError:
        result["reason"] = "unreadable"
        return result
    return {**result, "available": True, "entry_path": str(entry), "reason": None}
