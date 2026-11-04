const test = require('node:test')
const assert = require('node:assert/strict')
const { redactDiagnosticText, diagnosticRoute } = require('../src/diagnostic-privacy.mjs')

test('shared diagnostic privacy removes credentials, identities, addresses and paths', () => {
  const input = [
    'Authorization: Bearer secret-auth', 'Cookie: sid=secret-cookie; other=private-cookie',
    'Set-Cookie: sid=secret-set; Expires=Wed, 01 Jan 2030 00:00:00 GMT',
    '{"api_key":"secret-key","password":"secret-pass","user_name":"Alice Smith","project_name":"内部项目"}',
    'api_key="quoted key with spaces" token=unquoted-secret',
    'https://user:pass@10.23.45.67:8766/api/project/private-project?token=secret-url#secret-hash',
    'email alice@example.org user_name=alice-login',
    'at fn (/Users/Alice/private-project/source.ts:12:3)',
    'at C:\\Users\\Alice Smith\\private-project\\source.py:42',
    'address 192.168.2.23 fd12::1234 fe80::abcd ::1',
    'raw Bearer raw-secret', 'session_id=445cd2e0882143d2972f17e2693205ce',
    ['-----BEGIN', 'PRIVATE KEY-----\nsecret-private\n-----END PRIVATE KEY-----'].join(' '),
    'known raw-runtime-secret and CompanySecretProject',
  ].join('\n')
  const result = redactDiagnosticText(input, { secrets: ['raw-runtime-secret'], identities: ['CompanySecretProject'] })
  for (const secret of ['secret-auth', 'secret-cookie', 'private-cookie', 'secret-set', 'secret-key', 'secret-pass', 'Alice', '内部项目', 'quoted key', 'unquoted-secret', '10.23.45.67', 'private-project', 'secret-url', 'secret-hash', 'alice@example.org', 'alice-login', '192.168.2.23', 'fd12::1234', 'fe80::abcd', '::1', 'raw-secret', '445cd2e0882143d2972f17e2693205ce', 'secret-private', 'raw-runtime-secret', 'CompanySecretProject']) assert.ok(!result.includes(secret), secret)
  assert.match(result, /:12:3/)
  assert.match(result, /:42/)
  assert.equal(redactDiagnosticText(result), result, 'redaction must be safe to repeat')
})

test('request paths preserve only static route segments and never query or business IDs', () => {
  assert.equal(diagnosticRoute('/projects/secret-name/tasks/abc?token=secret#hash'), '/projects/:id/tasks/:id')
  assert.equal(diagnosticRoute('https://internal.example/api/chat-sessions/private/messages?limit=1'), '/api/chat-sessions/:id/messages')
  assert.equal(diagnosticRoute('/api/projects/%E7%A7%81%E6%9C%89%2Fpath'), '/api/projects/:id')
})

test('short known identities stay bounded across repeated redaction and process exit codes remain useful', () => {
  const context = { identities: ['a', 'redacted', '私人项目'] }
  const once = redactDiagnosticText('user a error in 私人项目 password=secret', context)
  assert.equal(redactDiagnosticText(once, context), once)
  assert.match(redactDiagnosticText('后台退出 {"code":2,"signal":null}'), /"code":2/)
  assert.ok(!redactDiagnosticText('auth_code=private-code').includes('private-code'))
})

test('unlabelled common key formats and additional absolute paths are removed', () => {
  for (const secret of ['sk-proj-' + 'x'.repeat(32), 'ghp_' + 'x'.repeat(32), 'github_pat_' + 'x'.repeat(32), 'eyJabc.defg.hijk', '/company-private/source.py', '"/Company Secret/source.py"', 'device.corp.internal']) {
    assert.ok(!redactDiagnosticText(`failure ${secret}`).includes(secret), secret)
  }
})
