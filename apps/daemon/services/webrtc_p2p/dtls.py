"""Memory-BIO DTLS 1.2 transport using pyOpenSSL and ephemeral ECDSA P-256 certs."""

from __future__ import annotations

import asyncio
import datetime
import hmac
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import OpenSSL.SSL as SSL
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EphemeralCertificate:
    cert: x509.Certificate
    private_key: ec.EllipticCurvePrivateKey
    fingerprint: str  # Uppercase colon-separated SHA-256


def generate_ephemeral_certificate() -> EphemeralCertificate:
    """Create a fresh self-signed ECDSA P-256 certificate for a DTLS peer."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "workstep-webrtc")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=30))
        .sign(private_key, hashes.SHA256())
    )
    digest_bytes = cert.fingerprint(hashes.SHA256())
    fingerprint = ":".join(f"{b:02X}" for b in digest_bytes)
    return EphemeralCertificate(
        cert=cert,
        private_key=private_key,
        fingerprint=fingerprint,
    )


class DtlsFingerprintMismatch(ValueError):
    pass


class DtlsTransport:
    """Asynchronous DTLS transport over an arbitrary datagram send callback."""

    def __init__(
        self,
        *,
        role: str,
        certificate: EphemeralCertificate,
        remote_fingerprint: str,
        send_packet: Callable[[bytes], Awaitable[None]],
        on_application_data: Callable[[bytes], Awaitable[None] | None] | None = None,
    ) -> None:
        if role not in {"client", "server"}:
            raise ValueError(f"Invalid DTLS role: {role}")
        self.role = role
        self.certificate = certificate
        self.remote_fingerprint = remote_fingerprint.strip().upper()
        self._send_packet = send_packet
        self.on_application_data = on_application_data

        ctx = SSL.Context(SSL.DTLS_METHOD)
        ctx.set_options(SSL.OP_NO_QUERY_MTU)
        ctx.set_cipher_list(
            b"ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:"
            b"ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:HIGH:!aNULL:!MD5"
        )
        ctx.use_certificate(certificate.cert)
        ctx.use_privatekey(certificate.private_key)
        ctx.set_verify(
            SSL.VERIFY_PEER | SSL.VERIFY_FAIL_IF_NO_PEER_CERT,
            lambda _conn, _x509, _errno, _depth, _ok: True,
        )

        self._conn = SSL.Connection(ctx, None)
        if hasattr(SSL, "_lib") and hasattr(SSL._lib, "SSL_set_mtu"):
            SSL._lib.SSL_set_mtu(self._conn._ssl, 1200)
        else:
            ctx.set_options(0)  # fallback
        if role == "client":
            self._conn.set_connect_state()
        else:
            self._conn.set_accept_state()

        self._handshake_done = asyncio.Event()
        self._handshake_error: Exception | None = None
        self._closed = False
        self._timeout_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._handshake_done.is_set() and self._handshake_error is None and not self._closed

    async def _flush_bio(self) -> None:
        while True:
            try:
                chunk = self._conn.bio_read(65536)
            except SSL.WantReadError:
                break
            if not chunk:
                break
            await self._send_packet(chunk)

    def _schedule_timeout(self) -> None:
        if self._timeout_task is not None:
            self._timeout_task.cancel()
            self._timeout_task = None
        if self._closed or self._handshake_done.is_set():
            return
        delay = self._conn.DTLSv1_get_timeout()
        if delay is None:
            return
        self._timeout_task = asyncio.create_task(self._on_timeout(max(0.05, float(delay))))

    async def _on_timeout(self, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
            async with self._lock:
                if self._closed or self._handshake_done.is_set():
                    return
                if self._conn.DTLSv1_handle_timeout():
                    await self._flush_bio()
                self._schedule_timeout()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.debug("DTLS timeout error: %s", exc)

    def _verify_peer_certificate(self) -> None:
        peer_cert = self._conn.get_peer_certificate()
        if peer_cert is None:
            raise DtlsFingerprintMismatch("Peer presented no DTLS certificate")
        actual = peer_cert.digest("sha256").decode("ascii").strip().upper()
        if not hmac.compare_digest(actual, self.remote_fingerprint):
            raise DtlsFingerprintMismatch("Peer DTLS certificate fingerprint mismatch")

    async def _step_handshake(self) -> None:
        try:
            self._conn.do_handshake()
        except SSL.WantReadError:
            await self._flush_bio()
            self._schedule_timeout()
            return
        except SSL.Error as exc:
            logger.debug("DTLS handshake SSL error: %s", exc)
            await self._flush_bio()
            self._handshake_error = exc
            self._handshake_done.set()
            raise

        await self._flush_bio()
        try:
            self._verify_peer_certificate()
        except Exception as exc:
            self._handshake_error = exc
            self._handshake_done.set()
            raise

        if self._timeout_task is not None:
            self._timeout_task.cancel()
            self._timeout_task = None
        self._handshake_done.set()

    async def handshake(self) -> None:
        async with self._lock:
            if not self._handshake_done.is_set():
                await self._step_handshake()
        await self._handshake_done.wait()
        if self._handshake_error is not None:
            raise self._handshake_error

    async def handle_incoming_packet(self, data: bytes) -> None:
        if self._closed:
            return
        app_chunks: list[bytes] = []
        async with self._lock:
            self._conn.bio_write(data)
            if not self._handshake_done.is_set():
                try:
                    await self._step_handshake()
                except Exception:
                    return
            if self._handshake_done.is_set() and self._handshake_error is None:
                while True:
                    try:
                        chunk = self._conn.recv(65536)
                    except (SSL.WantReadError, SSL.ZeroReturnError):
                        break
                    except SSL.Error as exc:
                        logger.debug("DTLS recv error: %s", exc)
                        break
                    if not chunk:
                        break
                    app_chunks.append(chunk)
                await self._flush_bio()

        if app_chunks and self.on_application_data is not None:
            for chunk in app_chunks:
                res = self.on_application_data(chunk)
                if asyncio.iscoroutine(res):
                    await res

    async def send_application_data(self, data: bytes) -> None:
        if self._closed:
            raise ConnectionError("DTLS transport is closed")
        if not self.connected:
            raise ConnectionError("DTLS handshake is not complete")
        async with self._lock:
            self._conn.send(data)
            await self._flush_bio()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._timeout_task is not None:
            self._timeout_task.cancel()
            self._timeout_task = None
        try:
            async with self._lock:
                try:
                    self._conn.shutdown()
                    await self._flush_bio()
                except Exception:
                    pass
        finally:
            self._handshake_done.set()
