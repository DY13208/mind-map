'use strict';
const test = require('node:test');
const assert = require('assert/strict');
const Module = require('module');

// Host checkout may not have container deps; stub pg so wiki.js can load.
const origRequire = Module.prototype.require;
Module.prototype.require = function mockRequire(id) {
  if (id === 'pg') return { Pool: class FakePool {} };
  return origRequire.apply(this, arguments);
};

const { wikiCreate, wikiUpdate } = require('../src/adapters/wiki');

test('wiki_create requires spaceId', async () => {
  await assert.rejects(
    () => wikiCreate('u1', { title: 'x', content: 'y' }, {}),
    (err) => err && err.code === 'missing_params',
  );
});

test('wiki_update requires pageId', async () => {
  await assert.rejects(
    () => wikiUpdate('u1', { title: 'x' }, {}),
    (err) => err && err.code === 'missing_params',
  );
});

test('wiki_update requires title or content', async () => {
  await assert.rejects(
    () => wikiUpdate('u1', { pageId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, {}),
    (err) => err && err.code === 'missing_params',
  );
});

test('wiki_update rejects bad operation before network', async () => {
  await assert.rejects(
    () =>
      wikiUpdate(
        'u1',
        {
          pageId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          content: 'hi',
          operation: 'merge',
        },
        { DOCMOST_DATABASE_URL: '', DOCMOST_APP_SECRET: '' },
      ),
    (err) => err && err.code === 'invalid_operation',
  );
});
