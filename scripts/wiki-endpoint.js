#!/usr/bin/env node
/**
 * wiki-endpoint.js —— knowledge-mcp（Wiki）端点的唯一解析处。
 *
 * 背景（2026-09-21 事故）：脚本里硬编码 `http://127.0.0.1:18792/mcp`，绕过了
 * mcp.json 里用户配置的公网地址，导致数据被写进「本机 Docker 里的另一套 Docmost」，
 * 而用户的真实 Wiki（xx.stillgroup.net:8989）里什么都没有——两边 pageId 体系不同，
 * 表面看不出来，极易误判为「写成功了」。
 *
 * 规则：
 *   1. **以 mcp.json 的 mind-map-wiki.url 为准**（用户配置即唯一事实来源）
 *   2. `KNOWLEDGE_MCP_URL` 只在显式设置时覆盖 mcp.json
 *   3. mcp.json 缺失/未配置时才回退本机默认，但**必须打印醒目告警**（stderr）
 *   4. 解析出的是回环地址时同样**打印告警**（很可能是写错了地方）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const MCP_CFG = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(),
  '.workbuddy', 'mcp.json');
const LOCAL_FALLBACK = 'http://127.0.0.1:18792/mcp';

function warn(msg) {
  process.stderr.write('\n⚠️  ' + msg + '\n\n');
}

/** 读 mcp.json 里的 mind-map-wiki 条目 */
function readEntry() {
  try {
    const cfg = JSON.parse(fs.readFileSync(MCP_CFG, 'utf8'));
    return (cfg.mcpServers || {})['mind-map-wiki'] || null;
  } catch {
    return null;
  }
}

function isLoopback(u) {
  try {
    const h = new URL(u).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
  } catch { return false; }
}

/**
 * 解析端点与令牌。
 * @returns {{url:string, token:string, source:string, isLocal:boolean}}
 */
function resolve(opts = {}) {
  const entry = readEntry();
  const cfgUrl = entry && entry.url;
  const cfgTok = entry && entry.headers && entry.headers.Authorization;

  let url, source;
  if (opts.url) {
    url = opts.url; source = '调用方显式传入';
  } else if (process.env.KNOWLEDGE_MCP_URL) {
    url = process.env.KNOWLEDGE_MCP_URL; source = '环境变量 KNOWLEDGE_MCP_URL';
  } else if (cfgUrl) {
    url = cfgUrl; source = 'mcp.json';
  } else {
    url = LOCAL_FALLBACK; source = '本机回退值（mcp.json 未配置）';
    warn('mcp.json 里没有 mind-map-wiki.url，已回退到本机 ' + LOCAL_FALLBACK +
      '\n   这很可能不是你想要的 Wiki！请检查 ~/.workbuddy/mcp.json');
  }

  let token;
  if (opts.token) token = opts.token;
  else if (cfgTok) token = String(cfgTok).replace(/^Bearer\s+/i, '');
  else throw new Error('mcp.json 里没有 mind-map-wiki.headers.Authorization');

  const isLocal = isLoopback(url);
  if (isLocal && !opts.allowLocal) {
    warn('解析出的 Wiki 端点是本机地址：' + url + '（来源：' + source + '）' +
      '\n   如果你要写的是线上 Wiki，这里写错了地方。' +
      '\n   确认要写本机请加 allowLocal: true / 设 KNOWLEDGE_MCP_URL。');
  }

  return { url, token, source, isLocal };
}

/** 从 mcp.json 只取令牌（兼容旧调用） */
function readToken() {
  const entry = readEntry();
  if (!entry || !entry.headers || !entry.headers.Authorization) {
    throw new Error('mcp.json 里没有 mind-map-wiki 的 Authorization');
  }
  return String(entry.headers.Authorization).replace(/^Bearer\s+/i, '');
}

/** 造一个 MCP 客户端（沿用各脚本原有的 fetch + SSE 解析方式） */
function makeClient(url, token) {
  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const call = async (payload) => {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) headers['mcp-session-id'] = sid;
    const text = await res.text();
    if (!text) return {};
    if (text.trimStart().startsWith('{')) return JSON.parse(text);
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : {};
  };
  return {
    call, url,
    async initialize() {
      await call({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wiki-endpoint', version: '1' } } });
      await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    async tool(name, args) {
      const r = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
      const res = (r && r.result) || {};
      const text = (res.content || [{}])[0].text || '{}';
      if (res.isError) throw new Error(text);
      return JSON.parse(text);
    },
    async listTools() {
      const r = await call({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
      return ((r && r.result) || {}).tools || [];
    },
  };
}

module.exports = { resolve, readToken, readEntry, makeClient, isLoopback, MCP_CFG, LOCAL_FALLBACK };

if (require.main === module) {
  const r = resolve({ allowLocal: process.argv.includes('--allow-local') });
  console.log('端点 URL :', r.url);
  console.log('来源     :', r.source);
  console.log('本机地址 :', r.isLocal);
  console.log('令牌     :', r.token.slice(0, 30) + '…');
  console.log('配置文件 :', MCP_CFG);
}
