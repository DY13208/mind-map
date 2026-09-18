'use strict';

function createCircuitBreaker(name, { failureThreshold = 5, resetMs = 30000 } = {}) {
  let failures = 0;
  let openUntil = 0;
  return {
    name,
    async exec(fn) {
      if (Date.now() < openUntil) {
        const err = new Error('circuit_open:' + name);
        err.code = 'circuit_open';
        err.source = name;
        throw err;
      }
      try {
        const out = await fn();
        failures = 0;
        return out;
      } catch (e) {
        failures += 1;
        if (failures >= failureThreshold) {
          openUntil = Date.now() + resetMs;
          failures = 0;
        }
        throw e;
      }
    },
    snapshot() {
      return { name, failures, open: Date.now() < openUntil, openUntil: openUntil || null };
    },
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('timeout:' + (label || 'op'));
        err.code = 'timeout';
        err.source = label;
        reject(err);
      }, Number(ms) || 5000);
    }),
  ]);
}

const breakers = {
  canonical: createCircuitBreaker('canonical'),
  docmost: createCircuitBreaker('docmost'),
  openwiki: createCircuitBreaker('openwiki'),
  aclDb: createCircuitBreaker('aclDb'),
};

function timeouts(env = process.env) {
  return {
    canonical: Number(env.KNOWLEDGE_MCP_TIMEOUT_CANONICAL_MS || 5000),
    docmost: Number(env.KNOWLEDGE_MCP_TIMEOUT_DOCMOST_MS || 8000),
    openwiki: Number(env.KNOWLEDGE_MCP_TIMEOUT_OPENWIKI_MS || 60000),
    aclDb: Number(env.KNOWLEDGE_MCP_TIMEOUT_ACL_MS || 3000),
  };
}

module.exports = {
  createCircuitBreaker,
  withTimeout,
  breakers,
  timeouts,
};
