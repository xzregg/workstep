import hashlib
import io
import json
import zipfile
import base64
import time
from types import SimpleNamespace

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import pytest

from services.gateway_client.skill_sync import apply_project_skills
from services.gateway_client.skill_sync_client import ManagedSkillSyncService, verify_skill_manifest
from services.gateway_client.control import GatewayControlClient
from services.gateway_client.policy import ManagedPolicyCache
from services.skill_center import SkillCenter


def _archive(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return stream.getvalue()


def _skill(raw, *, version_id="version-1", revision=1):
    return {"skill_id": "skill-1", "slug": "review",
            "skill_version_id": version_id, "version": "1.0.0",
            "digest": hashlib.sha256(raw).hexdigest(), "file_count": 1,
            "total_size": len("# Review"), "source_group_id": "group-1"}


def test_managed_skill_sync_preserves_local_conflict_and_rescans(tmp_path):
    project = tmp_path / "project"
    local = project / ".workstep" / "skills" / "review"
    local.mkdir(parents=True)
    (local / "SKILL.md").write_text("# Local")
    raw = _archive({"SKILL.md": "# Review"})
    desired = {"revision": 1, "skills": [_skill(raw)]}
    with pytest.raises(ValueError, match="name_conflict"):
        apply_project_skills(project, desired, {"version-1": raw})
    assert (local / "SKILL.md").read_text() == "# Local"
    local.rename(project / ".workstep" / "skills" / "local-review")
    apply_project_skills(project, desired, {"version-1": raw})
    assert (local / "SKILL.md").read_text() == "# Review"
    manifest = json.loads((project / ".workstep" / "skills" /
                           ".workstep-manifest.json").read_text())
    assert manifest["entries"]["gateway:skill-1"]["source"] == "gateway"
    center = SkillCenter(source_roots={"empty": tmp_path / "empty"})
    entries = center.list_project(project)
    assert any(item.source == "gateway" and item.enabled for item in entries)
    with pytest.raises(PermissionError):
        center.set_enabled(project, "gateway:skill-1", False)
    apply_project_skills(project, {"revision": 2, "skills": []}, {})
    assert not local.exists()
    assert (project / ".workstep" / "skills" / "local-review" / "SKILL.md").read_text() == "# Local"


def test_managed_skill_keeps_files_when_source_group_changes(tmp_path):
    project = tmp_path / "project"
    raw = _archive({"SKILL.md": "# Review"})
    apply_project_skills(project, {"revision": 1, "skills": [_skill(raw)]},
                         {"version-1": raw})
    replacement = {**_skill(raw), "source_group_id": "group-2"}
    apply_project_skills(project, {"revision": 2, "skills": [replacement]}, {})
    root = project / ".workstep" / "skills"
    assert (root / "review" / "SKILL.md").read_text() == "# Review"
    manifest = json.loads((root / ".workstep-manifest.json").read_text())
    assert manifest["entries"]["gateway:skill-1"]["source_group_id"] == "group-2"


def test_managed_skill_sync_rejects_bad_digest_and_escape(tmp_path):
    project = tmp_path / "project"
    raw = _archive({"SKILL.md": "# Review"})
    with pytest.raises(ValueError, match="digest"):
        apply_project_skills(project, {"revision": 1, "skills": [{
            **_skill(raw), "digest": "0" * 64,
        }]}, {"version-1": raw})
    with pytest.raises(ValueError, match="path"):
        apply_project_skills(project, {"revision": 1, "skills": [{
            **_skill(raw), "digest": hashlib.sha256(
                _archive({"SKILL.md": "# Review", "../escape": "bad"}),
            ).hexdigest(), "file_count": 2, "total_size": len("# Reviewbad"),
        }]}, {"version-1": _archive({"SKILL.md": "# Review", "../escape": "bad"})})
    with pytest.raises(ValueError, match="entry"):
        apply_project_skills(project, {"revision": 1, "skills": [{
            **_skill(raw), "skill_id": "../escape",
        }]}, {"version-1": raw})


def _signed_manifest(key, projects):
    encode = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    header = encode(b'{"alg":"EdDSA","typ":"JWT"}')
    payload = encode(json.dumps({
        "kind": "skill.manifest", "iss": "gateway-test",
        "gateway_id": "gateway-test", "device_id": "device-1",
        "user_id": "user-1", "iat": int(time.time()),
        "exp": int(time.time()) + 600, "projects": projects,
    }).encode())
    signed = f"{header}.{payload}"
    return signed + "." + encode(key.sign(signed.encode()))


@pytest.mark.asyncio
async def test_signed_skill_manifest_downloads_once_and_applies_revocation(tmp_path):
    key = Ed25519PrivateKey.generate()
    public = key.public_key()
    pem = public.public_bytes(serialization.Encoding.PEM,
                              serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    pin = hashlib.sha256(public.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    raw = _archive({"SKILL.md": "# Review"})
    project = tmp_path / "project"
    calls = []

    async def fetch(version_id, token):
        calls.append(version_id)
        return raw

    service = ManagedSkillSyncService("https://gateway.test",
                                      project_lookup=lambda project_id:
                                      SimpleNamespace(path=project) if project_id == "host-1" else None,
                                      fetcher=fetch)
    desired = [{"platform_project_id": "platform-1", "host_project_id": "host-1",
                "revision": 1, "skills": [_skill(raw)]}]
    token = _signed_manifest(key, desired)
    assert verify_skill_manifest(token, pem, pin, "gateway-test", "device-1",
                                 "user-1") == desired
    assert (await service.apply_manifest(token, pem, pin, "gateway-test",
                                         "device-1", "user-1"))[0]["status"] == "applied"
    assert (project / ".workstep" / "skills" / "review" / "SKILL.md").is_file()
    # Exercise the real Codex spawn adapter after signed deployment. The fake
    # process only substitutes the external binary; whitelist preparation runs.
    import asyncio
    from engines.codex import CodexEngine
    from services import config as config_module
    from services.skill_center import SkillCenter
    import services.skill_center as skill_module
    from unittest.mock import patch
    center = SkillCenter(source_roots={})
    commands = []
    async def subprocess(*args, **kwargs):
        commands.append(args)
        stdout = asyncio.StreamReader(); stdout.feed_eof()
        stderr = asyncio.StreamReader(); stderr.feed_eof()
        async def wait():
            return 0
        async def drain():
            pass
        stdin = SimpleNamespace(write=lambda _data: None, drain=drain, close=lambda: None)
        return SimpleNamespace(stdout=stdout, stderr=stderr, stdin=stdin, returncode=0, wait=wait)
    with patch.object(config_module, 'CONFIG_FILE', tmp_path / 'engine-config.json'), \
            patch.object(skill_module, 'skill_center', center), \
            patch.object(CodexEngine, 'provider_config_store', return_value=config_module.ConfigStore()), \
            patch.object(CodexEngine, 'resolve_binary', return_value='/fake/codex'), \
            patch.object(asyncio, 'create_subprocess_exec', subprocess):
        async for _event in CodexEngine().spawn(prompt='Review', cwd=str(project)):
            pass
    assert any('skills.config=' in arg and 'review' in arg for arg in commands[0])
    await service.apply_manifest(token, pem, pin, "gateway-test", "device-1", "user-1")
    assert calls == ["version-1"]
    (project / ".workstep" / "skills" / "review" / "SKILL.md").write_text("# Tampered")
    await service.apply_manifest(token, pem, pin, "gateway-test", "device-1", "user-1")
    assert (project / ".workstep" / "skills" / "review" / "SKILL.md").read_text() == "# Review"
    assert calls == ["version-1", "version-1"]
    revoked = _signed_manifest(key, [{**desired[0], "revision": 2, "skills": []}])
    assert (await service.apply_manifest(revoked, pem, pin, "gateway-test",
                                         "device-1", "user-1"))[0]["revision"] == 2
    assert not (project / ".workstep" / "skills" / "review").exists()
    with pytest.raises(ValueError):
        verify_skill_manifest(token + "x", pem, pin, "gateway-test", "device-1", "user-1")
    with pytest.raises(ValueError):
        verify_skill_manifest(token, pem, pin, "gateway-test", "other-device", "user-1")


@pytest.mark.asyncio
async def test_skill_sync_defers_while_project_has_running_task(tmp_path):
    key = Ed25519PrivateKey.generate()
    public = key.public_key()
    pem = public.public_bytes(serialization.Encoding.PEM,
                              serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    pin = hashlib.sha256(public.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    raw = _archive({"SKILL.md": "# Review"})
    project = tmp_path / "project"
    busy = True

    async def fetch(_version_id, _token):
        return raw

    service = ManagedSkillSyncService(
        "https://gateway.test",
        project_lookup=lambda _project_id: SimpleNamespace(path=project),
        fetcher=fetch, is_project_busy=lambda _project_id: busy,
    )
    token = _signed_manifest(key, [{
        "platform_project_id": "platform-1", "host_project_id": "host-1",
        "revision": 1, "skills": [_skill(raw)],
    }])
    result = await service.apply_manifest(token, pem, pin, "gateway-test",
                                          "device-1", "user-1")
    assert result[0]["status"] == "deferred"
    assert not (project / ".workstep" / "skills" / "review").exists()
    busy = False
    assert (await service.apply_manifest(token, pem, pin, "gateway-test",
                                         "device-1", "user-1"))[0]["status"] == "applied"


@pytest.mark.asyncio
async def test_control_reports_skill_application_and_checks_ack():
    import asyncio

    class FakeSync:
        async def apply_manifest(self, *args):
            return [{"project_id": "platform-1", "revision": 1,
                     "status": "applied", "error_code": None}]

    class Socket:
        sent = None

        async def send(self, raw):
            self.sent = json.loads(raw)

    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint="pin", user_id="user-1",
                                  policy_cache=ManagedPolicyCache(), skill_sync=FakeSync())
    socket = Socket()
    messages = asyncio.Queue()
    messages.put_nowait({"kind": "skill_applied_ack", "version": 1,
                         "device_id": "device-1", "projects": ["platform-1"]})
    await client._apply_skill_manifest(socket, messages, {"skill_manifest": "signed"},
                                       "gateway-key", "device-1")
    assert socket.sent["kind"] == "skill_applied"
    assert socket.sent["projects"][0]["project_id"] == "platform-1"


@pytest.mark.asyncio
async def test_slow_skill_disk_apply_keeps_event_loop_responsive(tmp_path, monkeypatch):
    import asyncio
    import threading
    import services.gateway_client.skill_sync_client as sync_client

    key = Ed25519PrivateKey.generate()
    public = key.public_key()
    pem = public.public_bytes(serialization.Encoding.PEM,
                              serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    pin = hashlib.sha256(public.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    raw = _archive({"SKILL.md": "# Review"})
    token = _signed_manifest(key, [{
        "platform_project_id": "platform-1", "host_project_id": "host-1",
        "revision": 1, "skills": [_skill(raw)],
    }])
    started = threading.Event()
    finish = threading.Event()
    original = sync_client.apply_project_skills

    def slow_apply(*args):
        started.set()
        assert finish.wait(timeout=3)
        return original(*args)

    monkeypatch.setattr(sync_client, "apply_project_skills", slow_apply)
    async def fetch(_version_id, _token):
        return raw
    service = ManagedSkillSyncService(
        "https://gateway.test", project_lookup=lambda _project_id:
        SimpleNamespace(path=tmp_path / "project"), fetcher=fetch,
    )
    task = asyncio.create_task(service.apply_manifest(
        token, pem, pin, "gateway-test", "device-1", "user-1",
    ))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.05)
    finally:
        finish.set()
    assert (await task)[0]["status"] == "applied"
