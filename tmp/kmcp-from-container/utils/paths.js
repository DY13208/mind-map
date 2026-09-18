'use strict';
const path = require('path');
const fs = require('fs');

function assertSafeRel(rel) {
  const s = String(rel || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || s.includes('\0')) {
    const e = new Error('invalid_path');
    e.code = 'invalid_path';
    throw e;
  }
  const parts = s.split('/');
  if (parts.some((p) => p === '..' || p === '')) {
    const e = new Error('path_traversal');
    e.code = 'path_traversal';
    throw e;
  }
  return parts.join('/');
}

function resolveUnder(rootDir, rel) {
  const safe = assertSafeRel(rel);
  const root = path.resolve(rootDir);
  const full = path.resolve(root, safe);
  if (full !== root && !full.startsWith(root + path.sep)) {
    const e = new Error('path_escape');
    e.code = 'path_escape';
    throw e;
  }
  return full;
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { assertSafeRel, resolveUnder, fileExists, dirExists };
