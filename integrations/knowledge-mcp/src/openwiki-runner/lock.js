'use strict';
const fs = require('fs');
const path = require('path');

const roomLocks = new Map();
let globalActive = 0;

function getLimits(env = process.env) {
  return {
    globalMax: Number(env.OPENWIKI_GLOBAL_CONCURRENCY || 2),
  };
}

async function withRoomLock(roomId, fn, env = process.env) {
  const key = String(roomId);
  while (roomLocks.get(key)) {
    await roomLocks.get(key);
  }
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  roomLocks.set(key, gate);
  const { globalMax } = getLimits(env);
  while (globalActive >= globalMax) {
    await new Promise((r) => setTimeout(r, 50));
  }
  globalActive += 1;
  try {
    return await fn();
  } finally {
    globalActive -= 1;
    roomLocks.delete(key);
    release();
  }
}

function lockFilePath(roomOutDir) {
  return path.join(roomOutDir, '.refresh.lock');
}

function tryAcquireFileLock(roomOutDir) {
  fs.mkdirSync(roomOutDir, { recursive: true });
  const lf = lockFilePath(roomOutDir);
  try {
    const fd = fs.openSync(lf, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseFileLock(roomOutDir) {
  try {
    fs.unlinkSync(lockFilePath(roomOutDir));
  } catch {
    /* ignore */
  }
}

module.exports = {
  withRoomLock,
  tryAcquireFileLock,
  releaseFileLock,
};
