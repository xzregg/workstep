"""Transport-independent failures from the identity service."""

from typing import Literal

from gateway.services.errors import GatewayError

IdentityFailure = Literal["unauthenticated", "forbidden", "not_found", "conflict", "invalid", "unavailable"]


class IdentityError(GatewayError):
    def __init__(self, reason: IdentityFailure, message: str):
        super().__init__(reason, message)
