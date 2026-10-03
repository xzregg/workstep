import pytest
from pydantic import ValidationError
from gateway.services.desktop_authorization_api import DesktopAuthorizeInput

BASE = dict(state='s'*32, nonce='n'*32, code_challenge='c'*43, app_instance_id='instance1', gateway_id='gateway1')

@pytest.mark.parametrize('uri', ['https://evil.test/api/gateway-platform/callback', 'http://localhost:8765/evil', 'http://u:p@localhost:8765/api/gateway-platform/callback', 'http://localhost:8765/api/gateway-platform/callback?evil=x'])
def test_daemon_callback_only_accepts_loopback_and_fixed_path(uri):
    with pytest.raises(ValidationError): DesktopAuthorizeInput(**BASE, redirect_uri=uri)


def test_daemon_callback_accepts_exact_local_route():
    assert DesktopAuthorizeInput(**BASE, redirect_uri='http://127.0.0.1:8765/api/gateway-platform/callback').redirect_uri
