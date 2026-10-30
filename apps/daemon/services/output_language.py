"""Per-request output language; never store browser preferences on the daemon."""
import re


def normalize_locale(locale: str | None) -> str:
    value = locale or ''
    return value if re.fullmatch(r'[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*', value) and len(value) <= 64 else 'en-US'


def output_language_instruction(locale: str | None) -> str:
    return (
        f"Write user-facing output in {normalize_locale(locale)}. "
        "Keep code, identifiers, paths, protocol fields and required formats unchanged. "
        "An explicit output-language request from the user takes precedence."
    )


def experience_limits(locale: str | None) -> tuple[int, int]:
    return (50, 150) if normalize_locale(locale).lower().startswith('zh') else (240, 720)
