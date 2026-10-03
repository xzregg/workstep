import pytest
from services.gateway_client.control import control_url, data_url


@pytest.mark.parametrize("origin,scheme", [("http://localhost:8700", "ws"),
                                           ("http://127.0.0.1:8700", "ws"),
                                           ("https://gateway.test:8700", "wss")])
def test_local_gateway_uses_matching_control_and_data_transport(origin, scheme):
    authority = origin.split("://", 1)[1]
    assert control_url(origin) == f"{scheme}://{authority}/api/control/ws"
    assert data_url(origin) == f"{scheme}://{authority}/api/data/ws"


def test_nonlocal_http_control_url_is_rejected():
    with pytest.raises(ValueError):
        control_url("http://gateway.test:8700")
