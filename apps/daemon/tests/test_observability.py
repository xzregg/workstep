"""Development observability configuration."""

import sys
from types import SimpleNamespace


def test_dev_observability_enables_logfire_without_console_output(monkeypatch):
    calls = []
    fake_logfire = SimpleNamespace(
        configure=lambda **kwargs: calls.append(("configure", kwargs)),
        instrument_pydantic_ai=lambda **kwargs: calls.append(
            ("instrument_pydantic_ai", kwargs)
        ),
    )
    monkeypatch.setitem(sys.modules, "logfire", fake_logfire)
    monkeypatch.setenv("WORKSTEP_ENV", "dev")

    from services.observability import configure_observability

    configure_observability()

    assert calls == [
        (
            "configure",
            {
                "send_to_logfire": "if-token-present",
                "console": False,
            },
        ),
        (
            "instrument_pydantic_ai",
            {
                "include_content": True,
                "include_binary_content": False,
            },
        ),
    ]


def test_non_dev_observability_does_not_configure_logfire(monkeypatch):
    calls = []
    fake_logfire = SimpleNamespace(
        configure=lambda **kwargs: calls.append(("configure", kwargs)),
        instrument_pydantic_ai=lambda **kwargs: calls.append(
            ("instrument_pydantic_ai", kwargs)
        ),
    )
    monkeypatch.setitem(sys.modules, "logfire", fake_logfire)
    monkeypatch.setenv("WORKSTEP_ENV", "prod")

    from services.observability import configure_observability

    configure_observability()

    assert calls == []


def test_dev_observability_instruments_fastapi_app(monkeypatch):
    calls = []
    fake_logfire = SimpleNamespace(
        instrument_fastapi=lambda app, **kwargs: calls.append(
            ("instrument_fastapi", app, kwargs)
        ),
    )
    monkeypatch.setitem(sys.modules, "logfire", fake_logfire)
    monkeypatch.setenv("WORKSTEP_ENV", "dev")

    from services.observability import instrument_fastapi

    app = object()
    instrument_fastapi(app)

    assert calls == [
        ("instrument_fastapi", app, {"capture_headers": False}),
    ]


def test_non_dev_observability_does_not_instrument_fastapi(monkeypatch):
    calls = []
    fake_logfire = SimpleNamespace(
        instrument_fastapi=lambda app, **kwargs: calls.append(
            ("instrument_fastapi", app, kwargs)
        ),
    )
    monkeypatch.setitem(sys.modules, "logfire", fake_logfire)
    monkeypatch.setenv("WORKSTEP_ENV", "prod")

    from services.observability import instrument_fastapi

    instrument_fastapi(object())

    assert calls == []
