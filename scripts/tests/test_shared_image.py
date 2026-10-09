"""Shared-image build contracts; runtime smoke checks live in verify_shared_image.py."""

from pathlib import Path
import json
import re
import shutil
import subprocess
import tempfile
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[2]


class SharedImageTests(unittest.TestCase):
    def test_legacy_docker_syntax(self):
        compose = (ROOT / "docker-compose.yaml").read_text()
        self.assertTrue(compose.startswith('version: "3.7"\n'))
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertNotIn("$BUILDPLATFORM", dockerfile)
        self.assertNotRegex(dockerfile, r"(?m)^COPY\s+--chmod")
        self.assertNotRegex(dockerfile, r"(?m)^RUN\s+--mount")

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose is required")
    def test_compose_services_share_image_but_have_independent_commands_and_home(self):
        result = subprocess.run(
            ["docker", "compose", "config", "--format", "json"], cwd=ROOT,
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(set(json.loads(result.stdout)["services"]), {"workstep"})
        compose = (ROOT / "docker-compose.yaml").read_text()
        enabled = "\n".join(line[2:] if line.startswith("# ") else line for line in compose.splitlines())
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "docker-compose.yaml"
            path.write_text(enabled)
            result = subprocess.run(
                ["docker", "compose", "--project-directory", str(ROOT), "-f", str(path), "config", "--format", "json"],
                capture_output=True, text=True, check=True,
            )
        services = json.loads(result.stdout)["services"]
        workstep, gateway = services["workstep"], services["gateway"]
        self.assertEqual(workstep["image"], gateway["image"])
        self.assertEqual(workstep["build"], gateway["build"])
        self.assertIn("main:app", workstep["command"])
        self.assertIn("gateway.app:app", gateway["command"])
        homes = [next(mount["source"] for mount in service["volumes"] if mount["target"] == "/root")
                 for service in (workstep, gateway)]
        self.assertNotEqual(*homes)
        self.assertNotIn("depends_on", gateway)

    def test_apps_do_not_import_each_others_frontend_source(self):
        for app, other in (("web", "gateway-web"), ("gateway-web", "web")):
            for path in (ROOT / "apps" / app / "src").rglob("*"):
                if path.suffix not in {".ts", ".tsx", ".css"}:
                    continue
                self.assertIsNone(
                    re.search(r"(?:from\s*|import\s*|@import\s*)['\"][^'\"]*/" + other + r"/src/", path.read_text()),
                    str(path.relative_to(ROOT)),
                )

    def test_image_contains_both_apps_and_gateway_workspace(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertIn("COPY apps/gateway /app/apps/gateway", dockerfile)
        self.assertIn("/app/apps/gateway-web/dist", dockerfile)
        self.assertIn("/app/apps/web/dist-gateway-share", dockerfile)
        self.assertIn("yarn build:gateway-share", dockerfile)

    def test_gateway_additions_preserve_shared_daemon_versions(self):
        lock = tomllib.loads((ROOT / "apps/daemon/uv.lock").read_text())
        versions = {}
        for package in lock["package"]:
            versions.setdefault(package["name"], set()).add(package["version"])
        for line in (ROOT / "scripts/container-gateway-requirements.txt").read_text().splitlines():
            if not line or line.startswith("#"):
                continue
            name, version = line.split("==", 1)
            if name in versions:
                self.assertIn(version, versions[name], f"Regenerate shared-image lock: {name}")


if __name__ == "__main__":
    unittest.main()
