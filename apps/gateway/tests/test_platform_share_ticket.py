import base64
import json

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from gateway.services.signing import GatewaySigner


def test_platform_share_ticket_is_short_lived_and_task_scoped():
    signer = GatewaySigner(Ed25519PrivateKey.generate())
    ticket = signer.sign_platform_share_ticket(
        gateway_id="gateway-1", device_id="device-1", share_id="share-1",
        project_id="project-1", host_project_id="host-1",
        task_id="task-1", mode="read_only",
    )
    header, payload, signature = ticket.split(".")
    signer.private_key.public_key().verify(
        base64.urlsafe_b64decode(signature + "==="), f"{header}.{payload}".encode(),
    )
    claims = json.loads(base64.urlsafe_b64decode(payload + "==="))
    assert claims["kind"] == "platform.share"
    assert claims["aud"] == "device-1"
    assert (claims["share_id"], claims["project_id"], claims["host_project_id"],
            claims["task_id"], claims["mode"]) == (
                "share-1", "project-1", "host-1", "task-1", "read_only",
            )
    assert claims["exp"] - claims["iat"] == 60
    assert "user_id" not in claims
    with pytest.raises(ValueError):
        signer.sign_platform_share_ticket(
            gateway_id="gateway-1", device_id="device-1", share_id="share-1",
            project_id="project-1", host_project_id="host-1",
            task_id="../task", mode="read_only",
        )


def test_interactive_ticket_embeds_only_the_share_creators_current_supplier_grants():
    signer = GatewaySigner(Ed25519PrivateKey.generate())
    ticket = signer.sign_platform_share_ticket(
        gateway_id='gateway', device_id='pc', share_id='share', project_id='project',
        host_project_id='host', task_id='task', mode='interactive', provider_ids=['supplier'])
    claims = json.loads(base64.urlsafe_b64decode(ticket.split('.')[1] + '==='))
    assert claims['provider_ids'] == ['supplier']
    assert claims['provider_grant_expires_at'] - claims['iat'] == 300
    with pytest.raises(ValueError):
        signer.sign_platform_share_ticket(
            gateway_id='gateway', device_id='pc', share_id='share', project_id='project',
            host_project_id='host', task_id='task', mode='read_only', provider_ids=['supplier'])
