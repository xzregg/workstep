"""Vendor callback wire format follows the published DingTalk/WeCom crypto protocol."""

import pytest

from gateway.callback_crypto import CallbackCrypto, InvalidCallback


def test_official_dingtalk_callback_vector():
    crypto = CallbackCrypto(
        token="mryue",
        encoding_aes_key="Yue0EfdN5900c1ce5cf6A152c63DDe1808a60c5ecd7",
        owner_key="ding6ccabc44d2c8d38b",
    )
    assert crypto.decrypt(
        signature="03044561471240d4a14bb09372dfcfd4fd0e40cb",
        timestamp="1608001896814", nonce="WL4PK6yA",
        encrypted="0vJiX6vliEpwG3U45CtXqi+m8PXbQRARJ8p8BbDuD1EMTDf0jKpQ79QS93qEk7XHpP6u+oTTrd15NRPvNvmBKyDCYxxOK+HZeKju4yhELOFchzNukR+t8SB/qk4ROMu3",
    ) == b'{"EventType":"check_url"}'


def test_callback_round_trip_and_rejects_tampering_and_wrong_owner():
    crypto = CallbackCrypto(token="a-token", encoding_aes_key="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
                            owner_key="tenant-a")
    payload = '{"name":"张三"}'.encode()
    response = crypto.encrypt(payload, timestamp="123", nonce="nonce")
    assert crypto.decrypt(signature=response["msg_signature"], timestamp="123", nonce="nonce",
                          encrypted=response["encrypt"]) == payload
    with pytest.raises(InvalidCallback):
        crypto.decrypt(signature="bad", timestamp="123", nonce="nonce", encrypted=response["encrypt"])
    other = CallbackCrypto(token="a-token", encoding_aes_key="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
                           owner_key="tenant-b")
    with pytest.raises(InvalidCallback):
        other.decrypt(signature=response["msg_signature"], timestamp="123", nonce="nonce",
                      encrypted=response["encrypt"])
