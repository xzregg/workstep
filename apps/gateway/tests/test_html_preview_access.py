from dataclasses import replace
from types import SimpleNamespace
from urllib.parse import urlsplit

from gateway.contracts import GatewayCall, ProofHeaders, QueryValues
from gateway.services.identity import COOKIE_NAME
from gateway.services.html_preview_access import register_preview_grant, preview_resource_identity


def test_resource_ticket_restores_only_its_own_session_and_transport(monkeypatch):
    import gateway.services.html_preview_access as preview
    now = [100.0]
    monkeypatch.setattr(preview.time, 'monotonic', lambda: now[0])
    owner = SimpleNamespace()
    opened = GatewayCall(control_connections=owner, tokens={COOKIE_NAME: 'viewer-session'},
                         proofs=ProofHeaders({'host': 'gateway.test'}), workspace_path='/workspace/device-1',
                         query_values=QueryValues((('project_id', 'project-1'),)))
    token = 'a' * 43
    register_preview_grant(opened, token)
    resource = replace(opened, tokens={}, target=urlsplit('https://gateway.test/api/fs/html-resource/project-1/' + token + '/data.json'))
    assert preview_resource_identity(resource).tokens[COOKIE_NAME] == 'viewer-session'
    assert not resource.tokens
    for rejected in (
        replace(resource, operation='POST'),
        replace(resource, target=urlsplit('https://gateway.test/api/admin/users')),
        replace(resource, workspace_path='/workspace/device-2'),
        replace(resource, proofs=ProofHeaders({'host': 'other.test'})),
        replace(resource, target=urlsplit(resource.target.geturl().replace('project-1', 'project-2'))),
        replace(resource, target=urlsplit(resource.target.geturl().replace(token, 'b' * 43))),
    ):
        assert not preview_resource_identity(rejected).tokens
    now[0] += 3601
    assert not preview_resource_identity(resource).tokens


def test_grant_cache_is_bounded_and_rejects_uncredentialed_registration():
    owner = SimpleNamespace()
    anonymous = GatewayCall(control_connections=owner)
    register_preview_grant(anonymous, 'a' * 43)
    assert not hasattr(owner, 'html_preview_grants')
    call = replace(anonymous, tokens={COOKIE_NAME: 'session'})
    register_preview_grant(call, 'bad-token')
    assert not hasattr(owner, 'html_preview_grants')
    for index in range(1030):
        register_preview_grant(call, f'{index:043d}')
    assert len(owner.html_preview_grants) == 1024
