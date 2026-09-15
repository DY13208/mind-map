#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal MCP client for the mind-map HTTP server (streamable HTTP)."""
import json, os, re, sys, urllib.request, uuid

BASE = "http://192.168.1.114:8989/mcp"
ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
TOKEN = None
with open(ENV_PATH, "r", encoding="utf-8") as f:
    for line in f:
        m = re.match(r"\s*MCP_TOKEN\s*=\s*(.*)$", line)
        if m:
            TOKEN = m.group(1).strip().strip('"').strip("'")
            break
if not TOKEN:
    sys.exit("MCP_TOKEN not found")

SESSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wb_mcp_session.txt")
SESSION = None
if os.path.exists(SESSION_FILE):
    SESSION = open(SESSION_FILE, encoding="utf-8").read().strip()


def _post(body_obj):
    global SESSION
    req_id = body_obj.get("id")  # notifications have no id
    body = json.dumps(body_obj).encode()
    headers = {
        "Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if SESSION:
        headers["mcp-session-id"] = SESSION
    req = urllib.request.Request(BASE, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        sid = resp.headers.get("mcp-session-id")
        if sid:
            SESSION = sid
            with open(SESSION_FILE, "w", encoding="utf-8") as f:
                f.write(sid)
        raw = resp.read().decode("utf-8", "replace")
    data_lines, results = [], []
    for line in raw.splitlines():
        line = line.rstrip("\r")
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif line == "" and data_lines:
            results.append("".join(data_lines))
            data_lines = []
    if data_lines:
        results.append("".join(data_lines))
    for block in results:
        try:
            obj = json.loads(block)
        except Exception:
            continue
        if obj.get("id") == req_id:
            return obj
    return None


def _init():
    global SESSION
    SESSION = None
    res = _post({"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "initialize",
                 "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                            "clientInfo": {"name": "workbuddy", "version": "1.0"}}})
    # send initialized notification (required by streamable HTTP servers)
    _post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
    return res


_TOOLS = {"list_maps", "create_map", "get_map", "search_nodes", "query_nodes", "list_todos", "prepare_todo",
          "complete_todo", "propose_sop_improvement", "apply_sop_improvement", "add_node",
          "update_node", "delete_node", "replace_tree", "rename_map", "delete_map", "get_share_link"}


def call(method, params, _retried=False):
    req_id = str(uuid.uuid4())
    if method in _TOOLS:
        body_obj = {"jsonrpc": "2.0", "id": req_id, "method": "tools/call",
                    "params": {"name": method, "arguments": params}}
    else:
        body_obj = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
    try:
        obj = _post(body_obj)
    except urllib.error.HTTPError as e:
        errtext = e.read().decode("utf-8", "replace")
        if not _retried and ("Session expired" in errtext or e.code == 404):
            _init()
            return call(method, params, _retried=True)
        print("HTTPError", e.code, errtext[:800])
        sys.exit(2)
    if obj is None:
        print("No result block")
        sys.exit(4)
    if "error" in obj:
        err = obj["error"]
        msg = json.dumps(err, ensure_ascii=False)
        if not _retried and ("Session expired" in msg):
            _init()
            return call(method, params, _retried=True)
        print("RPC_ERROR:", msg)
        sys.exit(3)
    res = obj.get("result")
    if method in _TOOLS and isinstance(res, dict) and isinstance(res.get("content"), list):
        texts = []
        for c in res["content"]:
            if isinstance(c, dict) and c.get("type") == "text":
                t = c.get("text", "")
                try:
                    texts.append(json.loads(t))
                except Exception:
                    texts.append(t)
        if len(texts) == 1:
            return texts[0]
        return texts
    return res


if __name__ == "__main__":
    method = sys.argv[1]
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    res = call(method, params)
    print(json.dumps(res, ensure_ascii=False))
