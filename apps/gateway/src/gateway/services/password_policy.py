"""Shared policy for every platform account password write."""
import re
from gateway.services.identity_errors import IdentityError

PASSWORD_REQUIREMENTS = "密码须为 8–128 位，包含大小写字母、数字、符号中的至少三类，且不能使用常见弱密码或与账号相同。"
_WEAK = {"password", "password1", "password123", "passw0rd", "qwerty", "qwerty123", "123456", "12345678", "123456789", "1234567890", "admin", "admin123", "abc123", "abc123456", "abcdef", "abcdefgh", "letmein", "welcome", "welcome1", "iloveyou", "changeme", "workstep", "workstep123"}


def validate_password(username: str, password: str) -> None:
    categories = sum(bool(re.search(pattern, password)) for pattern in
                     (r"[a-z]", r"[A-Z]", r"[0-9]", r"[^a-zA-Z0-9\s]"))
    folded = password.casefold()
    plain = re.sub(r"[^a-z0-9]", "", folded)
    if (not 8 <= len(password) <= 128 or categories < 3
            or folded == username.casefold() or plain in _WEAK
            or re.search(r"(.)\1{3,}", plain)):
        raise IdentityError("invalid", PASSWORD_REQUIREMENTS)
