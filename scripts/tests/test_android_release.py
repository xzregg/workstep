"""Android unsigned APK is an explicit, gated release asset, never a debug build."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class AndroidReleaseTests(unittest.TestCase):
    def test_release_tests_and_build_gate_android_upload(self):
        workflow = (ROOT / '.github/workflows/desktop-release.yml').read_text()
        job = workflow.split('\n  android:\n', 1)[1].split('\n  publish-draft:', 1)[0]
        self.assertIn('if: ${{ !inputs.image_only }}', job)
        self.assertIn('needs: validate', job)
        self.assertIn('testReleaseUnitTest lintRelease assembleRelease', job)
        self.assertIn('--max-workers=2', job)
        self.assertIn('app-release-unsigned.apk', job)
        self.assertNotIn('assembleDebug', job)
        self.assertIn('apksigner" verify', job)
        self.assertIn('WorkStep-android-unsigned.apk', job)
        self.assertIn('name: desktop-android', job)
        draft = workflow.split('\n  publish-draft:\n', 1)[1]
        self.assertIn('needs: [macos, windows, linux, android]', draft)
        self.assertIn('pattern: desktop-*', draft)
        self.assertIn('sha256sum WorkStep-*', draft)

    def test_notes_and_documentation_explain_self_signing(self):
        changelog = (ROOT / 'CHANGELOG.md').read_text().split('## 1.0.27\n', 1)[1].split('\n## ', 1)[0]
        self.assertIn('unsigned Android APK', changelog)
        self.assertIn('sign it yourself before installation', changelog)
        self.assertIn('WorkStep-android-unsigned.apk', (ROOT / 'docs/releasing.md').read_text())


if __name__ == '__main__':
    unittest.main()
