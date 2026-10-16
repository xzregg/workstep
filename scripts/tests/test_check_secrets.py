"""Reviewed documentation must not hide later credential additions."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('check_secrets', ROOT / 'scripts/check_secrets.py')
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)
ROLE = 'apps/daemon/data/role-center/roles/agency-367eccc119495783b1e97dc108c4b3ea.json'


class ReviewedDocumentationTests(unittest.TestCase):
    def test_reviewed_role_contains_only_documentation_markers(self):
        content = (ROOT / ROLE).read_text(encoding='utf-8')
        self.assertEqual(scanner.matching_kinds(content), ['private key'])
        self.assertEqual(scanner.unreviewed_kinds(ROLE, content), [])

    def test_same_documentation_elsewhere_is_not_exempt(self):
        content = (ROOT / ROLE).read_text(encoding='utf-8')
        self.assertEqual(scanner.unreviewed_kinds('another.json', content), ['private key'])

    def test_changed_role_is_scanned_again(self):
        content = (ROOT / ROLE).read_text(encoding='utf-8') + '\n'
        self.assertEqual(scanner.unreviewed_kinds(ROLE, content), ['private key'])

    def test_added_credential_is_not_exempt(self):
        content = (ROOT / ROLE).read_text(encoding='utf-8') + 'gh' + 'p_' + 'x' * 36
        self.assertIn('GitHub token', scanner.unreviewed_kinds(ROLE, content))

    def test_private_key_markers_remain_detected_by_default(self):
        header = '-' * 5 + 'BEGIN PRIVATE KEY' + '-' * 5
        self.assertEqual(scanner.unreviewed_kinds('credential.pem', header), ['private key'])

    def test_history_uses_the_same_exact_content_review(self):
        original = (ROOT / ROLE).read_bytes()
        for content, expected in [(original, []), (original + b'\n', [f'abc123:{ROLE}'])]:
            with self.subTest(changed=content != original):
                def run(*args, **kwargs):
                    if args[1] == 'ls-files':
                        output = b''
                    elif args[1] == 'rev-list':
                        output = b'abc123\n'
                    elif args[1] == 'grep':
                        output = f'abc123:{ROLE}\n'.encode()
                    elif args[1] == 'show':
                        output = content
                    else:
                        self.fail(f'Unexpected Git operation: {args[1]}')
                    return subprocess.CompletedProcess(args, 0, stdout=output)
                with patch.object(scanner, '_run', run):
                    self.assertEqual(scanner.scan(), expected)


if __name__ == '__main__':
    unittest.main()
