import pytest

from services.config import ConfigStore


@pytest.mark.parametrize("values", [{}, {"engine_idle_timeout_seconds": None},
                                    {"engine_idle_timeout_seconds": "invalid"}])
def test_engine_idle_timeout_defaults_to_twenty_minutes(values):
    store = ConfigStore()
    store._cache = values
    assert store.get_engine_idle_timeout_seconds() == 1200


@pytest.mark.parametrize("value, expected", [(600, 600), ("1200", 1200),
                                           (0, 0), (-1, 0)])
def test_engine_idle_timeout_preserves_explicit_configuration(value, expected):
    store = ConfigStore()
    store._cache = {"engine_idle_timeout_seconds": value}
    assert store.get_engine_idle_timeout_seconds() == expected
