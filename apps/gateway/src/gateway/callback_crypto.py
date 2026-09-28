"""DingTalk and WeCom encrypted callback envelope primitives.

Protocol: SHA-1 of sorted token/timestamp/nonce/ciphertext, followed by
AES-256-CBC with a 32-byte PKCS#7 pad unit and a verified owner suffix.
"""

import base64
import binascii
import hashlib
import hmac
import secrets
import struct

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


class InvalidCallback(ValueError):
    pass


class CallbackCrypto:
    def __init__(self, *, token: str, encoding_aes_key: str, owner_key: str):
        if not token or not owner_key or len(encoding_aes_key) != 43:
            raise ValueError("Invalid callback configuration")
        try:
            aes_key = base64.b64decode(encoding_aes_key + "=", validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Invalid callback AES key") from exc
        if len(aes_key) != 32:
            raise ValueError("Invalid callback AES key")
        self.token = token
        self.owner_key = owner_key.encode()
        self.aes_key = aes_key

    def signature(self, timestamp: str, nonce: str, encrypted: str) -> str:
        joined = "".join(sorted((self.token, timestamp, nonce, encrypted)))
        return hashlib.sha1(joined.encode()).hexdigest()

    def decrypt(self, *, signature: str, timestamp: str, nonce: str, encrypted: str) -> bytes:
        if not hmac.compare_digest(signature, self.signature(timestamp, nonce, encrypted)):
            raise InvalidCallback("Callback signature mismatch")
        try:
            ciphertext = base64.b64decode(encrypted, validate=True)
            if not ciphertext or len(ciphertext) % 16:
                raise InvalidCallback("Invalid callback ciphertext")
            decryptor = Cipher(algorithms.AES(self.aes_key), modes.CBC(self.aes_key[:16])).decryptor()
            plain = decryptor.update(ciphertext) + decryptor.finalize()
        except (binascii.Error, ValueError) as exc:
            raise InvalidCallback("Invalid callback ciphertext") from exc
        padding = plain[-1]
        if not 1 <= padding <= 32 or plain[-padding:] != bytes([padding]) * padding:
            raise InvalidCallback("Invalid callback padding")
        plain = plain[:-padding]
        if len(plain) < 20:
            raise InvalidCallback("Invalid callback payload")
        length = struct.unpack(">I", plain[16:20])[0]
        if len(plain) != 20 + length + len(self.owner_key):
            raise InvalidCallback("Invalid callback payload length")
        if not hmac.compare_digest(plain[20 + length:], self.owner_key):
            raise InvalidCallback("Callback owner mismatch")
        return plain[20:20 + length]

    def encrypt(self, payload: bytes, *, timestamp: str, nonce: str) -> dict[str, str]:
        if len(payload) > 1024 * 1024:
            raise ValueError("Callback response too large")
        plain = secrets.token_bytes(16) + struct.pack(">I", len(payload)) + payload + self.owner_key
        padding = 32 - len(plain) % 32
        plain += bytes([padding]) * padding
        encryptor = Cipher(algorithms.AES(self.aes_key), modes.CBC(self.aes_key[:16])).encryptor()
        encrypted = base64.b64encode(encryptor.update(plain) + encryptor.finalize()).decode()
        return {"msg_signature": self.signature(timestamp, nonce, encrypted),
                "timeStamp": timestamp, "nonce": nonce, "encrypt": encrypted}
