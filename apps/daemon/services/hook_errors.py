"""Hook domain errors, translated to HTTP only by the API layer."""


class HookError(ValueError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
