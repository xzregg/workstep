import pytest
from gateway.services.password_policy import validate_password
from gateway.services.identity_errors import IdentityError


@pytest.mark.parametrize('password', ['123456', '12345678', 'abcdefgh', 'Abcdefgh', 'Password1!', 'Qwerty123!', 'Owner123!', 'aaaaaaaaA1!'])
def test_weak_passwords_are_rejected(password):
    with pytest.raises(IdentityError):
        validate_password('owner123!', password)


def test_password_matching_account_is_rejected():
    with pytest.raises(IdentityError):
        validate_password('Owner123!', 'owner123!')


def test_strong_password_is_accepted():
    validate_password('owner', 'UniquePassphrase-2026!')
