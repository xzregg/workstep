"""Business failures; HTTP status mapping belongs to the API adapter."""


class GatewayError(Exception):
    def __init__(self, reason: str, message: str | None = None):
        super().__init__(message)
        self.reason = reason
        self.message = message
