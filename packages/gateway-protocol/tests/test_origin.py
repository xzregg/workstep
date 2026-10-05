import pytest

from workstep_gateway_protocol.origin import validate_daemon_origin, validate_gateway_origin


@pytest.mark.parametrize('origin', ['http://192.168.1.10:8765', 'http://workstep.local:8765', 'http://[fd00::1]:8765', 'https://workstep.example.com'])
def test_mobile_callback_origin_accepts_the_browser_entry(origin):
    assert validate_daemon_origin(origin) == origin


@pytest.mark.parametrize('origin', ['http://192.168.1.10:8700', 'http://gateway.example.com'])
def test_callback_support_does_not_relax_gateway_trust(origin):
    with pytest.raises(ValueError): validate_gateway_origin(origin)


@pytest.mark.parametrize('origin', ['javascript:alert(1)', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com#hash', 'https://example.com\\evil', 'https://exa mple.com', 'https://example.com:0'])
def test_mobile_callback_origin_rejects_malformed_origins(origin):
    with pytest.raises(ValueError): validate_daemon_origin(origin)
