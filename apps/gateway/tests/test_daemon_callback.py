import pytest
from pydantic import ValidationError
from gateway.services.desktop_authorization_api import DesktopAuthorizeInput

BASE = dict(state='s'*32, nonce='n'*32, code_challenge='c'*43, app_instance_id='instance1', gateway_id='gateway1')

@pytest.mark.parametrize('uri', ['javascript:alert(1)', 'http://localhost:8765/evil', 'http://u:p@localhost:8765/api/gateway-platform/callback', 'http://localhost:8765/api/gateway-platform/callback?evil=x', 'https://workstep.example.com/api/gateway-platform/callback#fragment', 'https://workstep.example.com\\evil/api/gateway-platform/callback'])
def test_daemon_callback_only_accepts_browser_origins_and_fixed_path(uri):
    with pytest.raises(ValidationError): DesktopAuthorizeInput(**BASE, redirect_uri=uri)


@pytest.mark.parametrize('origin', ['http://127.0.0.1:8765', 'http://192.168.1.10:8765', 'https://workstep.example.com', 'http://[fd00::1]:8765'])
def test_daemon_callback_accepts_desktop_and_mobile_browser_entries(origin):
    assert DesktopAuthorizeInput(**BASE, redirect_uri=origin+'/api/gateway-platform/callback').redirect_uri
