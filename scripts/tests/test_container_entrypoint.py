"""Run with Python inside a Linux container; never starts the WorkStep server."""

import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


ENTRYPOINT = Path(__file__).resolve().parents[1] / "container-entrypoint.sh"


class PortableRuntimeTests(unittest.TestCase):
    def test_terminfo_case_aliases_use_distinct_hex_buckets(self):
        spec = importlib.util.spec_from_file_location(
            "prepare_runtime", ENTRYPOINT.with_name("prepare-container-runtime.py")
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            source = runtime / "python/cpython/share/terminfo"
            (source / "n").mkdir(parents=True)
            (source / "N").mkdir()
            (source / "n/name").write_bytes(b"terminal data")
            (source / "N/NAME").symlink_to("../n/name")
            module.prepare_terminfo(runtime)
            self.assertEqual((source / "6e/name").read_bytes(), b"terminal data")
            self.assertEqual((source / "4e/NAME").read_bytes(), b"terminal data")
            self.assertFalse((source / "4e/NAME").is_symlink())


class ContainerEntrypointTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "home with spaces"
        self.home.mkdir()
        self.seed = self.root / "seed"
        self.seed.mkdir()
        self.runtime = self.home / ".workstep/runtime"
        self.environment = {
            **os.environ,
            "HOME": str(self.home),
            "WORKSTEP_RUNTIME_SEED_DIR": str(self.seed),
        }
        self.write_seed("first")

    def write_seed(self, version):
        payload = self.root / "payload/base/bin"
        payload.mkdir(parents=True, exist_ok=True)
        (payload / "runtime-version").write_text(version)
        archive = self.seed / "base.tar"
        with tarfile.open(archive, "w") as output:
            output.add(payload.parent, arcname="base")
        self.digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.seed / "base.sha256").write_text(self.digest + "\n")

    def start(self, *command):
        return subprocess.run(
            ["/bin/sh", str(ENTRYPOINT), *command],
            env=self.environment, text=True, capture_output=True,
        )

    def test_empty_mounted_home_initializes_and_passes_command_arguments(self):
        result = self.start("/bin/sh", "-c", 'printf "%s" "$1"', "test", "two words")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "two words")
        self.assertEqual((self.runtime / "base/bin/runtime-version").read_text(), "first")
        self.assertEqual((self.runtime / "base/.image-sha256").read_text().strip(), self.digest)

    def test_restart_reuses_runtime_and_preserves_installed_engines(self):
        self.assertEqual(self.start("true").returncode, 0)
        runtime_file = self.runtime / "base/bin/runtime-version"
        runtime_file.write_text("existing")
        for relative in (".codex/auth.json", ".claude.json", ".workstep/runtime/npm/package", ".workstep/runtime/python-packages/sdk"):
            path = self.home / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("user data")
        result = self.start("true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(runtime_file.read_text(), "existing")
        self.assertEqual((self.home / ".codex/auth.json").read_text(), "user data")
        self.assertEqual((self.home / ".claude.json").read_text(), "user data")
        self.assertEqual((self.runtime / "npm/package").read_text(), "user data")
        self.assertEqual((self.runtime / "python-packages/sdk").read_text(), "user data")

    def test_new_image_replaces_only_base_runtime(self):
        self.assertEqual(self.start("true").returncode, 0)
        installed = self.runtime / "npm/user-engine"
        installed.parent.mkdir(parents=True)
        installed.write_text("installed")
        self.write_seed("second")
        result = self.start("true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.runtime / "base/bin/runtime-version").read_text(), "second")
        self.assertEqual(installed.read_text(), "installed")

    def test_corrupt_seed_keeps_previous_runtime_and_does_not_run_command(self):
        self.assertEqual(self.start("true").returncode, 0)
        self.write_seed("second")
        (self.seed / "base.tar").write_bytes(b"corrupt")
        marker = self.root / "command-ran"
        result = self.start("touch", str(marker))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertEqual((self.runtime / "base/bin/runtime-version").read_text(), "first")

    def test_interrupted_swap_recovers_previous_runtime(self):
        self.assertEqual(self.start("true").returncode, 0)
        (self.runtime / "base").rename(self.runtime / ".base-previous")
        result = self.start("true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.runtime / "base/bin/runtime-version").exists())

    def test_initialization_waits_for_shared_home_lock(self):
        self.runtime.mkdir(parents=True)
        marker = self.root / "command-ran"
        with (self.runtime / ".bootstrap.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen(
                ["/bin/sh", str(ENTRYPOINT), "touch", str(marker)],
                env=self.environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    process.wait(timeout=0.2)
                self.assertFalse(marker.exists())
                fcntl.flock(lock, fcntl.LOCK_UN)
                _, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, stderr.decode())
                self.assertTrue(marker.exists())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    unittest.main()
