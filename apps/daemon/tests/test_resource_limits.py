from types import SimpleNamespace

import pytest

from services import resource_limits


@pytest.mark.parametrize("soft,hard,requested,expected", [
    (256, -1, "4096", 4096), (256, 1024, "4096", 1024),
    (8192, -1, "4096", 8192), (-1, -1, "4096", -1),
    (256, -1, "8192", 8192),
])
def test_daemon_startup_raises_only_soft_limit(monkeypatch, soft, hard, requested, expected):
    calls = []
    state = [soft, hard]

    def set_limit(_key, value):
        calls.append(value)
        state[:] = value

    monkeypatch.setattr(resource_limits, "resource", SimpleNamespace(
        RLIMIT_NOFILE=7, RLIM_INFINITY=-1,
        getrlimit=lambda _: tuple(state), setrlimit=set_limit,
    ))
    monkeypatch.setenv("WORKSTEP_NOFILE_LIMIT", requested)
    assert resource_limits.configure_file_limit() == expected
    assert all(pair[1] == hard for pair in calls)
    assert len(calls) == (1 if expected != soft else 0)


def test_windows_without_resource_module_is_supported(monkeypatch):
    monkeypatch.setattr(resource_limits, "resource", None)
    assert resource_limits.configure_file_limit() is None


@pytest.mark.parametrize("requested", ["bad", "0", "-1", "999999999999"])
def test_invalid_runtime_limit_preserves_process(monkeypatch, requested):
    monkeypatch.setenv("WORKSTEP_NOFILE_LIMIT", requested)
    monkeypatch.setattr(resource_limits, "resource", SimpleNamespace(
        RLIMIT_NOFILE=7, RLIM_INFINITY=-1, getrlimit=lambda _: (256, -1),
        setrlimit=lambda *_: pytest.fail("invalid limit must not be applied"),
    ))
    assert resource_limits.configure_file_limit() == 256


def test_runtime_limit_uses_default_and_preserves_on_os_failure(monkeypatch):
    monkeypatch.delenv("WORKSTEP_NOFILE_LIMIT", raising=False)
    calls = []

    def denied(key, limits):
        calls.append(limits)
        raise OSError("not permitted")

    monkeypatch.setattr(resource_limits, "resource", SimpleNamespace(
        RLIMIT_NOFILE=7, RLIM_INFINITY=-1, getrlimit=lambda _: (256, -1), setrlimit=denied,
    ))
    assert resource_limits.configure_file_limit() == 256
    assert calls == [(4096, -1)]
