'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { signToken, verifyToken } = require('../src/auth/jwt');
const { resolveUnder } = require('../src/utils/paths');

test('jwt roundtrip', () => {
  const secret = 'x'.repeat(32);
  const { token, payload } = signToken({ userId: 'u1', secret, ttlSec: 120 });
  const got = verifyToken(token, { secret });
  assert.equal(got.sub, 'u1');
  assert.equal(got.jti, payload.jti);
});

test('jwt rejects wrong aud', () => {
  const secret = 'y'.repeat(32);
  const { token } = signToken({ userId: 'u1', secret, aud: 'other' });
  assert.throws(() => verifyToken(token, { secret, aud: 'knowledge-mcp' }), /bad_aud/);
});

test('path traversal blocked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kmcp-'));
  assert.throws(() => resolveUnder(root, '../etc/passwd'));
  assert.throws(() => resolveUnder(root, 'a/../../b'));
});
