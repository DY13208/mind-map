'use strict';

function knowledgeResult(partial = {}) {
  return {
    source: partial.source ?? null,
    authority: partial.authority ?? null,
    roomId: partial.roomId ?? null,
    topicKey: partial.topicKey ?? null,
    title: partial.title ?? null,
    uri: partial.uri ?? null,
    snippet: partial.snippet ?? null,
    body: partial.body ?? null,
    version: partial.version ?? null,
    updatedAt: partial.updatedAt ?? null,
    owner: partial.owner ?? null,
    pageType: partial.pageType ?? null,
    derived: partial.derived ?? null,
  };
}

function authorityForDocmostSlot(slot, owner) {
  if (slot === 'standard' || owner === 'mindmap') return 'formal-mirror';
  if (slot === 'human' || owner === 'human') return 'human-supplement';
  if (slot === 'ai' || owner === 'ai') return 'ai-derived';
  return 'unknown';
}

module.exports = { knowledgeResult, authorityForDocmostSlot };
