import json

import pytest

from gateway.api.errors import identity_error_response
from gateway.services.identity import IdentityService
from gateway.services.identity_errors import IdentityError


async def test_identity_service_reports_business_error_without_http_request():
    with pytest.raises(IdentityError) as rejected:
        await IdentityService(None).session_user(None)
    assert rejected.value.reason == "unauthenticated"
    assert rejected.value.message == "Authentication required"


@pytest.mark.parametrize("reason,status", [
    ("unauthenticated", 401), ("forbidden", 403), ("not_found", 404),
    ("conflict", 409), ("invalid", 422), ("unavailable", 503),
])
async def test_identity_errors_keep_existing_public_response(reason, status):
    response = await identity_error_response(None, IdentityError(reason, "Business error"))
    assert response.status_code == status
    assert json.loads(response.body) == {"error": {
        "code": "not_found" if status == 404 else "http_error",
        "message": "Business error",
    }}
