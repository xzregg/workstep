"""Development-only observability setup."""

import os


def configure_observability() -> None:
    """Enable Pydantic AI traces for daemon processes started in dev mode."""
    if os.environ.get("WORKSTEP_ENV") != "dev":
        return

    import logfire

    logfire.configure(
        send_to_logfire="if-token-present",
        console=False,
    )
    logfire.instrument_pydantic_ai(
        include_content=True,
        include_binary_content=False,
    )


def instrument_fastapi(app: object) -> None:
    """Enable FastAPI request traces for daemon processes started in dev mode."""
    if os.environ.get("WORKSTEP_ENV") != "dev":
        return

    import logfire

    logfire.instrument_fastapi(app, capture_headers=False)
