#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
按钮派发本地任务 —— 桥接服务

原理:
  1. 桌面版 WorkBuddy 每条会话都在本机起一个 HTTP 网关 http://127.0.0.1:<随机端口>
     端口记录在 ~/.workbuddy/sessions/<pid>.json 的 url 字段
  2. 网关暴露官方 REST API:
       GET  /api/v1/health          健康检查
       GET  /api/v1/jobs            后台任务列表
       POST /api/v1/jobs            派发后台 Agent 任务  <- 按钮走这里
       POST /api/v1/jobs/:id/stop   停止任务
  3. 请求必须带两个头:
       X-CodeBuddy-Request: 1
       Authorization: Bearer <网关密码>   来自环境变量 CODEBUDDY_GATEWAY_PASSWORD
  4. 本脚本起一个本地网页, 页面上有按钮 + 目标工作区下拉框, 点一下即派发

用法:
    python bridge.py                     只在本机打开按钮
    python bridge.py --lan               按钮页面给局域网打开，执行仍在每台自己的电脑
    python bridge.py --port 8799         指定本服务端口
    python bridge.py --password xxx      手动指定网关密码(或写 gateway.json)
每台电脑都运行一次（要局域网按钮就加 --lan）。
打开 http://<任意一台的局域网IP>:8799/ ，点运行只会调用这台电脑的
http://127.0.0.1:8799 ，结果回到当前页面。

密码查找顺序: --password、环境变量、gateway.json、
~/.workbuddy/settings.json 的 gateway.password、
正在运行的会话进程环境变量 CODEBUDDY_GATEWAY_PASSWORD。
"""

import argparse
import ctypes
import glob
import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WORKBUDDY_DIR = os.path.join(os.path.expanduser("~"), ".workbuddy")
SESSIONS_DIR = os.path.join(WORKBUDDY_DIR, "sessions")
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gateway.json")
HEARTBEAT_FRESH_MS = 10 * 60 * 1000
_proc_env_cache = {}


def log(*a):
    print(*a, flush=True)


def _json_password(path, *keys):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            cur = json.load(f)
        for key in keys:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(key)
        if isinstance(cur, str) and cur:
            return cur
    except Exception:
        return None
    return None


def _process_env_var(pid, name):
    """只读本机会话进程里的某一个环境变量。桌面版把网关密码放在这里，不写盘。"""
    if os.name != "nt" or not pid or ctypes.sizeof(ctypes.c_void_p) < 8:
        return None
    now = time.time()
    hit = _proc_env_cache.get((pid, name))
    if hit and now - hit[0] < 5:
        return hit[1] or None

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll", use_last_error=True)

    class PBI(ctypes.Structure):
        _fields_ = [
            ("Reserved1", ctypes.c_void_p),
            ("PebBaseAddress", ctypes.c_void_p),
            ("Reserved2_0", ctypes.c_void_p),
            ("Reserved2_1", ctypes.c_void_p),
            ("UniqueProcessId", ctypes.c_void_p),
            ("Reserved3", ctypes.c_void_p),
        ]

    def read_mem(handle, addr, size):
        buf = (ctypes.c_ubyte * size)()
        got = ctypes.c_size_t()
        kernel32.ReadProcessMemory(handle, ctypes.c_void_p(addr), buf, size, ctypes.byref(got))
        return bytes(buf[: got.value])

    value = None
    handle = kernel32.OpenProcess(0x0400 | 0x0010, False, int(pid))
    if handle:
        try:
            info = PBI()
            retlen = ctypes.c_ulong()
            status = ntdll.NtQueryInformationProcess(
                handle, 0, ctypes.byref(info), ctypes.sizeof(info), ctypes.byref(retlen))
            peb = info.PebBaseAddress
            if status == 0 and peb:
                params = int.from_bytes(read_mem(handle, peb + 0x20, 8), "little")
                env_ptr = int.from_bytes(read_mem(handle, params + 0x80, 8), "little")
                blob = b""
                for off in range(0, 1024 * 1024, 65536):
                    chunk = read_mem(handle, env_ptr + off, 65536)
                    if not chunk:
                        break
                    blob += chunk
                    if b"\x00\x00\x00\x00" in blob:
                        break
                prefix = name + "="
                for item in blob.decode("utf-16le", "ignore").split("\x00"):
                    if item.startswith(prefix):
                        value = item[len(prefix):] or None
                        break
        except Exception:
            value = None
        finally:
            kernel32.CloseHandle(handle)
    _proc_env_cache[(pid, name)] = (now, value or "")
    return value


def candidate_passwords(explicit=None):
    """按优先级给出 (密码, 来源)。显式参数优先，且不和其他来源混用。"""
    if explicit:
        return [(explicit, "命令行")]
    found = []
    seen = set()

    def add(pw, source):
        if pw and pw not in seen:
            seen.add(pw)
            found.append((pw, source))

    add(os.environ.get("CODEBUDDY_GATEWAY_PASSWORD"), "环境变量")
    add(_json_password(CONFIG_PATH, "password"), "gateway.json")
    add(_json_password(os.path.join(WORKBUDDY_DIR, "settings.local.json"), "gateway", "password"),
        "settings.local.json")
    add(_json_password(os.path.join(WORKBUDDY_DIR, "settings.json"), "gateway", "password"),
        "settings.json")
    for session in list_live_sessions():
        add(_process_env_var(session.get("pid"), "CODEBUDDY_GATEWAY_PASSWORD"), "本机 WorkBuddy 进程")
    return found


def resolve_password(explicit=None):
    found = candidate_passwords(explicit)
    return found[0][0] if found else None


def http_json(base, path, method="GET", body=None, password=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, method=method, data=data)
    req.add_header("X-CodeBuddy-Request", "1")
    if password:
        req.add_header("Authorization", "Bearer " + password)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw or "{}")
        except Exception:
            return e.code, {"raw": raw}
    except Exception as e:
        return "ERR", {"error": str(e)}


_title_cache = {"at": 0.0, "map": {}}


def session_titles():
    """工作区目录 → 左侧任务名。同目录多条时用最近更新的那条。"""
    now = time.time()
    if now - _title_cache["at"] < 5:
        return _title_cache["map"]
    found = {}
    db = os.path.join(WORKBUDDY_DIR, "workbuddy.db")
    if os.path.isfile(db):
        try:
            import sqlite3
            con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=1)
            try:
                rows = con.execute(
                    "SELECT cwd, custom_title, title FROM sessions "
                    "WHERE deleted_at IS NULL ORDER BY updated_at DESC")
                for cwd, custom, title in rows:
                    name = (custom or title or "").strip()
                    key = os.path.normcase(os.path.normpath(cwd or ""))
                    if key and name and key not in found:
                        found[key] = name
            finally:
                con.close()
        except Exception:
            pass
    _title_cache["at"] = now
    _title_cache["map"] = found
    return found


_ws_cache = {"at": 0.0, "cwd": ""}


def latest_workspace_cwd():
    """最近更新过的那条任务的工作区。内部 CLI 主机的 cwd 是临时目录, 用它兜底。"""
    now = time.time()
    if now - _ws_cache["at"] < 5:
        return _ws_cache["cwd"]
    cwd = ""
    db = os.path.join(WORKBUDDY_DIR, "workbuddy.db")
    if os.path.isfile(db):
        try:
            import sqlite3
            con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=1)
            try:
                rows = con.execute(
                    "SELECT cwd FROM sessions WHERE deleted_at IS NULL "
                    "ORDER BY updated_at DESC LIMIT 20").fetchall()
                for (item,) in rows:
                    item = (item or "").strip()
                    low = item.replace("/", "\\").lower()
                    if not item or "workbuddy-host-cli" in low or "__workbuddy_cli_host__" in low:
                        continue
                    cwd = item
                    break
            finally:
                con.close()
        except Exception:
            pass
    _ws_cache["at"] = now
    _ws_cache["cwd"] = cwd
    return cwd


def list_live_sessions():
    """本机会话, 可用的在前。

    心跳过期和 WorkBuddy 内部 CLI 主机都不再直接丢掉, 只降权:
      - 心跳过期(stale): 网关可能还活着, 交给 is_alive 判定, 只影响排序
      - 内部 CLI 主机(internal): 桌面版空闲 / 刚重启时它常常是唯一活着的网关,
        它的 cwd 是临时目录, 换成最近任务的工作区
    排序: 正常新会话 > 正常旧会话 > 内部主机
    """
    now = time.time() * 1000
    titles = session_titles()
    fallback_cwd = latest_workspace_cwd()
    out = []
    for f in glob.glob(os.path.join(SESSIONS_DIR, "*.json")):
        try:
            with open(f, "r", encoding="utf-8") as fh:
                j = json.load(fh)
        except Exception:
            continue
        url = j.get("url")
        if not url:
            continue
        hb = j.get("lastHeartbeat") or 0
        cwd = j.get("cwd") or ""
        cwd_key = cwd.replace("/", "\\").lower()
        internal = "workbuddy-host-cli" in cwd_key or "__workbuddy_cli_host__" in cwd_key
        if internal and fallback_cwd:
            cwd = fallback_cwd
        key = os.path.normcase(os.path.normpath(cwd)) if cwd else ""
        title = titles.get(key) or ""
        if internal and not title:
            title = "WorkBuddy 内部主机"
        out.append({"url": url.rstrip("/"), "cwd": cwd, "title": title,
                    "pid": j.get("pid"), "version": j.get("version"),
                    "ageMs": int(max(0, now - hb)),
                    "stale": (now - hb) > HEARTBEAT_FRESH_MS,
                    "internal": internal,
                    "startedAt": j.get("startedAt") or 0})
    out.sort(key=lambda x: (x["internal"], x["stale"], x["ageMs"]))
    return out


_health_cache = {}




def _err_text(body):
    """把网关错误体收成可读字符串，避免页面出现 [object Object]。"""
    if body is None:
        return "未知错误"
    if isinstance(body, str):
        return body
    if not isinstance(body, dict):
        return str(body)
    err = body.get("error")
    if isinstance(err, dict):
        msg = err.get("message") or err.get("code")
        if msg:
            return str(msg)
    if isinstance(err, str) and err:
        return err
    if isinstance(body.get("raw"), str) and body.get("raw"):
        return body["raw"]
    if isinstance(body.get("message"), str) and body.get("message"):
        return body["message"]
    try:
        return json.dumps(body, ensure_ascii=False)
    except Exception:
        return str(body)


def dispatch_to_gateway(g, prompt, name=None, cwd=None):
    """优先 POST /api/v1/jobs；若该会话未挂载 Jobs 路由(404)，回退到 POST /api/v1/runs。

    产物目录默认用网关自己的 cwd；调用方可以显式传 cwd 覆盖
    （内部 CLI 主机的 cwd 是临时目录, 由页面/按钮指定真正的工作区）。
    """
    target_cwd = (cwd or g.get("cwd") or "").strip()
    req = {
        "prompt": prompt or "",
        "name": name or "按钮派发的任务",
        "cwd": target_cwd,
    }
    if os.environ.get("BTN_PERMISSION_MODE"):
        req["permissionMode"] = os.environ["BTN_PERMISSION_MODE"]
    st, body = http_json(g["url"], "/api/v1/jobs", method="POST", body=req,
                         password=g.get("password"), timeout=60)
    log("[dispatch:jobs]", g["url"], st, json.dumps(body, ensure_ascii=False)[:200])
    if st in (200, 201):
        job = body.get("data", {}) if isinstance(body, dict) else {}
        return True, {"ok": True, "mode": "jobs", "job": job, "gatewayCwd": target_cwd}

    raw = _err_text(body)
    jobs_missing = (st == 404) or ("No mapping found" in raw and "/api/v1/jobs" in raw)
    if jobs_missing:
        run_req = {
            "text": prompt or "",
            "sender": {"id": "lan-bridge", "name": "局域网按钮"},
        }
        st2, body2 = http_json(g["url"], "/api/v1/runs", method="POST", body=run_req,
                               password=g.get("password"), timeout=60)
        log("[dispatch:runs]", g["url"], st2, json.dumps(body2, ensure_ascii=False)[:200])
        if st2 in (200, 201, 202):
            data = body2.get("data", {}) if isinstance(body2, dict) else {}
            run_id = data.get("runId") or data.get("id") or ""
            # 伪装成 job，方便现有页面轮询展示
            fake = {
                "id": run_id,
                "name": name or "按钮派发的任务",
                "state": "working",
                "detail": "已通过 /api/v1/runs 发给当前会话 Agent",
                "cwd": target_cwd,
                "mode": "runs",
            }
            return True, {"ok": True, "mode": "runs", "job": fake, "gatewayCwd": target_cwd}
        return False, {
            "ok": False,
            "status": st2,
            "error": (
                "该 WorkBuddy 会话既没有 Jobs 派发接口，Runs 也失败："
                + _err_text(body2)
                + "。请新开一个 WorkBuddy 对话窗口后再试，或升级 WorkBuddy。"
            ),
        }

    return False, {"ok": False, "status": st, "error": raw}


def job_full_text(g, job_id):
    """任务的完整回答。

    /api/v1/jobs 列表里的 detail 只有一行摘要（实测 96 字）。
    全文有两个来源：
      - GET /api/v1/jobs/:id            → data.job.output.result
      - GET /api/v1/jobs/:id/transcript → agent_message_chunk 拼接
    实测两者长度经常不一样（1788 vs 836、1667 vs 0），transcript 更全，所以取长的那个。
    """
    out = {"text": "", "detail": "", "source": "", "job": {}}
    if not job_id:
        return out
    password = g.get("password")
    st, body = http_json(g["url"], "/api/v1/jobs/%s" % job_id,
                         password=password, timeout=20)
    if st == 200 and isinstance(body, dict):
        job = (body.get("data") or {}).get("job") or {}
        out["job"] = {k: job[k] for k in ("id", "name", "state", "cwd", "sessionId",
                                          "startedAt", "updatedAt") if job.get(k) is not None}
        detail = job.get("detail") or ""
        if detail.lower().startswith("result:"):
            detail = detail[7:].strip()
        out["detail"] = detail
        result = ((job.get("output") or {}).get("result") or "").strip()
        if result:
            out["text"] = result
            out["source"] = "output"

    st, body = http_json(g["url"], "/api/v1/jobs/%s/transcript" % job_id,
                         password=password, timeout=30)
    if st == 200 and isinstance(body, dict):
        updates = (body.get("data") or {}).get("updates") or []
        chunk = "".join(
            ((u.get("content") or {}).get("text") or "")
            for u in updates
            if isinstance(u, dict) and u.get("sessionUpdate") == "agent_message_chunk"
        ).strip()
        if len(chunk) > len(out["text"]):
            out["text"] = chunk
            out["source"] = "transcript"
    return out


# ---------------------------------------------------------------------------
# MCP（Streamable HTTP，零依赖）：把桥接本身变成一条 MCP 链接 http://<host>:8799/mcp
# ---------------------------------------------------------------------------

MCP_PROTOCOL_VERSION = "2025-06-18"
MCP_SERVER_INFO = {"name": "workbuddy-bridge", "version": "1.0.0"}
_MCP_SESSION_ID = os.urandom(16).hex()
HUB_URL = None  # --hub 传进来的通讯页地址, 给 bridge_hosts 用


def mcp_tools():
    return [
        {
            "name": "bridge_status",
            "description": "这台电脑现在能不能派任务：列出可用的 WorkBuddy 会话；没有可用会话时说明原因"
                           "（网关已失效 / 内部 CLI 主机 / 心跳过期）。派发前先调这个。",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        {
            "name": "bridge_hosts",
            "description": "局域网里已登记的主机（通讯页 /api/peers）。要派到别的电脑，就用那台机器的 MCP 链接。",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        {
            "name": "dispatch_task",
            "description": "在本机 WorkBuddy 上派一个后台任务，产物落在指定工作目录。返回任务 id，之后用 job_result 取完整回答。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "任务内容"},
                    "gateway": {"type": "string", "description": "目标 WorkBuddy 会话网关地址，不填用首个可用"},
                    "name": {"type": "string", "description": "任务名，便于在运行历史里认出来"},
                    "cwd": {"type": "string", "description": "产物目录，默认用该会话的工作目录"},
                },
                "required": ["prompt"],
                "additionalProperties": False,
            },
        },
        {
            "name": "list_jobs",
            "description": "运行历史：这台电脑上的后台任务列表（含状态、任务名、摘要）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "gateway": {"type": "string", "description": "只看某个会话，不填用首个可用"},
                    "limit": {"type": "integer", "description": "最多返回几条，默认 20"},
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "job_result",
            "description": "取某个任务的完整回答（任务列表里只有一行摘要，全文在这里）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "任务 id"},
                    "gateway": {"type": "string", "description": "该任务所在会话，不填用首个可用"},
                },
                "required": ["id"],
                "additionalProperties": False,
            },
        },
        {
            "name": "stop_job",
            "description": "停止一个正在跑的任务",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "任务 id"},
                    "gateway": {"type": "string", "description": "该任务所在会话，不填用首个可用"},
                },
                "required": ["id"],
                "additionalProperties": False,
            },
        },
    ]


def pick_gateway(want, explicit_password=None):
    """只接受出现在本机会话列表里的地址, 其余一律丢弃（防 SSRF）"""
    gws = resolve_gateways(explicit_password)
    if want:
        for g in gws:
            if g["url"] == want:
                return g
        return None
    return gws[0] if gws else None


def _mcp_result(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _mcp_error(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def mcp_call(name, args, explicit_password=None):
    """返回 (文本, 是否错误)"""
    args = args or {}
    if name == "bridge_status":
        gws = resolve_gateways(explicit_password)
        return json.dumps(gateways_payload(gws), ensure_ascii=False), False

    if name == "bridge_hosts":
        if not HUB_URL:
            return "没有配置通讯页（启动时加 --hub http://<ip>:5000）。" \
                   "要派到别的电脑，直接用那台机器的 MCP 链接。", False
        st, body = http_json(HUB_URL, "/api/peers", timeout=6)
        if st != 200:
            return "通讯页 %s 拿不到主机列表：%s" % (HUB_URL, _err_text(body)), True
        return json.dumps(body, ensure_ascii=False), False

    if name == "dispatch_task":
        prompt = (args.get("prompt") or "").strip()
        if not prompt:
            return "prompt 不能为空", True
        g = pick_gateway(args.get("gateway"), explicit_password)
        if not g:
            return "本机没有可用的 WorkBuddy 会话。先调 bridge_status 看原因，" \
                   "并确认桌面版 WorkBuddy 开着。", True
        ok, payload = dispatch_to_gateway(g, prompt, args.get("name"), args.get("cwd"))
        payload["gateway"] = g["url"]
        return json.dumps(payload, ensure_ascii=False), not ok

    if name == "list_jobs":
        g = pick_gateway(args.get("gateway"), explicit_password)
        if not g:
            return "本机没有可用的 WorkBuddy 会话", True
        st, body = http_json(g["url"], "/api/v1/jobs?all=1", password=g.get("password"), timeout=15)
        if st != 200:
            return "拿不到任务列表：%s" % _err_text(body), True
        jobs = (body.get("data") or {}).get("jobs") or []
        try:
            limit = int(args.get("limit") or 20)
        except (TypeError, ValueError):
            limit = 20
        keep = ("id", "name", "state", "tempo", "intent", "detail", "cwd",
                "startedAt", "updatedAt", "alive")
        jobs = [{k: j.get(k) for k in keep if j.get(k) is not None} for j in jobs[:limit]]
        return json.dumps({"gateway": g["url"], "jobs": jobs}, ensure_ascii=False), False

    if name == "job_result":
        job_id = (args.get("id") or "").strip()
        if not job_id:
            return "id 不能为空", True
        g = pick_gateway(args.get("gateway"), explicit_password)
        if not g:
            return "本机没有可用的 WorkBuddy 会话", True
        info = job_full_text(g, job_id)
        info["gateway"] = g["url"]
        info["chars"] = len(info["text"])
        return json.dumps(info, ensure_ascii=False), False

    if name == "stop_job":
        job_id = (args.get("id") or "").strip()
        if not job_id:
            return "id 不能为空", True
        g = pick_gateway(args.get("gateway"), explicit_password)
        if not g:
            return "本机没有可用的 WorkBuddy 会话", True
        st, body = http_json(g["url"], "/api/v1/jobs/%s/stop" % job_id, method="POST",
                             body={}, password=g.get("password"), timeout=30)
        out = {"ok": st == 200, "status": st, "result": body, "gateway": g["url"]}
        return json.dumps(out, ensure_ascii=False), st != 200

    return "未知工具：%s" % name, True


def mcp_handle(msg, explicit_password=None):
    """处理一条 JSON-RPC 消息；通知类返回 None（不需要响应体）"""
    if not isinstance(msg, dict):
        return _mcp_error(None, -32600, "Invalid Request")
    msg_id = msg.get("id")
    method = msg.get("method") or ""
    params = msg.get("params") or {}
    if method.startswith("notifications/"):
        return None
    if method == "initialize":
        return _mcp_result(msg_id, {
            "protocolVersion": params.get("protocolVersion") or MCP_PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": MCP_SERVER_INFO,
            "instructions": ("按钮派发本地任务的本机桥接。派发前先 bridge_status 看有没有可用会话；"
                             "派完用 job_result 取完整回答（list_jobs 里只有一行摘要）。"),
        })
    if method == "ping":
        return _mcp_result(msg_id, {})
    if method == "tools/list":
        return _mcp_result(msg_id, {"tools": mcp_tools()})
    if method == "tools/call":
        name = params.get("name") or ""
        try:
            text, is_err = mcp_call(name, params.get("arguments") or {}, explicit_password)
        except Exception as exc:  # noqa: BLE001 - 工具内的异常也要回给调用方
            text, is_err = "调用失败：%s" % exc, True
        result = {"content": [{"type": "text", "text": text}]}
        if is_err:
            result["isError"] = True
        return _mcp_result(msg_id, result)
    if method == "resources/list":
        return _mcp_result(msg_id, {"resources": []})
    if method == "resources/templates/list":
        return _mcp_result(msg_id, {"resourceTemplates": []})
    if method == "prompts/list":
        return _mcp_result(msg_id, {"prompts": []})
    if method == "logging/setLevel":
        return _mcp_result(msg_id, {})
    return _mcp_error(msg_id, -32601, "Method not found: %s" % method)


def is_alive(url, password):
    """带 5 秒缓存的健康检查, 且只有回环地址才放行(防 SSRF)"""
    if not (url.startswith("http://127.0.0.1:") or url.startswith("http://localhost:")
            or url.startswith("http://[::1]:")):
        return False
    now = time.time()
    key = (url, hash(password or ""))
    hit = _health_cache.get(key)
    if hit and now - hit[0] < 5:
        return hit[1]
    st, body = http_json(url, "/api/v1/health", password=password, timeout=3)
    ok = st == 200 and isinstance(body, dict) and body.get("data", {}).get("status") == "ok"
    _health_cache[key] = (now, ok)
    return ok


def _with_password(session, explicit=None):
    """给会话配上能通过健康检查的密码。密码留在内部字典, 不要回给网页。"""
    trials = []
    if not explicit:
        proc_pw = _process_env_var(session.get("pid"), "CODEBUDDY_GATEWAY_PASSWORD")
        if proc_pw:
            trials.append((proc_pw, "本机 WorkBuddy 进程"))
    for pw, source in candidate_passwords(explicit):
        if all(pw != old for old, _ in trials):
            trials.append((pw, source))
    trials.append((None, ""))
    for pw, source in trials:
        if is_alive(session["url"], pw):
            item = dict(session)
            if pw:
                item["password"] = pw
                item["pwSource"] = source
            return item
    return None


def resolve_gateways(password, only_alive=True):
    """返回可用的网关列表; url 一律来自本机会话文件, 不接受外部传入的任意地址"""
    res = []
    for session in list_live_sessions():
        if only_alive:
            item = _with_password(session, password)
            if item:
                res.append(item)
            continue
        item = dict(session)
        if password:
            item["password"] = password
        res.append(item)
    return res


def public_gateway(gateway):
    keys = ("url", "cwd", "title", "pid", "version", "ageMs", "startedAt",
            "internal", "stale")
    return {k: gateway[k] for k in keys if k in gateway}


def gateways_payload(gws):
    """给页面的 /api/gateways 响应: 可用网关 + 为什么没有可用的。"""
    reasons = []
    for s in list_live_sessions():
        if any(g["url"] == s["url"] for g in gws):
            continue
        if s.get("internal"):
            why = "内部 CLI 主机, 网关没起来"
        elif s.get("stale"):
            why = "心跳超过 %d 分钟且网关已失效" % (HEARTBEAT_FRESH_MS // 60000)
        else:
            why = "网关已失效"
        reasons.append({"cwd": s["cwd"], "why": why})
    return {
        "gateways": [public_gateway(g) for g in gws],
        "hasPassword": any(g.get("password") for g in gws),
        "diag": {
            "sessions": len(reasons) + len(gws),
            "alive": len(gws),
            "skipped": reasons[:6],
        },
    }


PAGE = r"""<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>按钮派发本地任务</title>
<style>
:root{--bg:#1b1b1a;--card:#262624;--line:#3a3a37;--fg:#e8e6e1;--dim:#a3a09a;
      --accent:#7fa8e8;--ok:#7bc99a;--warn:#e0a94f;--err:#e08a8a}
*{box-sizing:border-box}
body{margin:0;padding:28px;background:var(--bg);color:var(--fg);
     font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:840px;margin:0 auto}
h1{font-size:18px;font-weight:500;margin:0 0 4px}
.sub{color:var(--dim);font-size:13px;margin-bottom:20px}
.ok{color:var(--ok)}.bad{color:var(--err)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
      padding:18px;margin-bottom:16px}
label{display:block;font-size:13px;color:var(--dim);margin-bottom:6px}
textarea,input,select{width:100%;background:#1f1f1e;border:1px solid var(--line);border-radius:8px;
      color:var(--fg);font:13px/1.6 inherit;padding:10px;outline:none}
textarea{min-height:84px;resize:vertical}
textarea:focus,input:focus,select:focus{border-color:var(--accent)}
button{margin-top:14px;width:100%;padding:13px;border:0;border-radius:9px;cursor:pointer;
      background:var(--accent);color:#10131a;font-size:15px;font-weight:500}
button:hover{filter:brightness(1.08)}
button:disabled{opacity:.5;cursor:default}
button.mini{margin:0;width:auto;padding:3px 9px;font-size:12px;background:#3a3a37;color:var(--fg)}
#msg{margin-top:12px;font-size:13px;min-height:20px}
.job{border-top:1px solid var(--line);padding:10px 0;font-size:13px}
.job:first-child{border-top:0}
.job .top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.job .name{font-weight:500}
.job .meta{color:var(--dim);font-size:12px;margin-top:3px;word-break:break-all}
.job .result{margin-top:6px;font-size:13px;white-space:pre-wrap;word-break:break-word}
.job .actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.full{margin-top:8px;padding:10px;background:#1f1f1e;border:1px solid var(--line);
      border-radius:6px;font-size:12.5px;line-height:1.65;white-space:pre-wrap;
      word-break:break-word;max-height:380px;overflow:auto}
.full .head{color:var(--dim);font-size:12px;margin-bottom:6px}
#result{max-height:420px;overflow:auto;background:#1f1f1e;border:1px solid var(--line);
        border-radius:8px;padding:10px;font-size:12.5px;line-height:1.65}
#result:empty{display:none}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;
     vertical-align:middle;background:var(--dim)}
.s-working{background:var(--warn)}.s-done{background:var(--ok)}
.s-completed{background:var(--ok)}.s-failed{background:var(--err)}.s-stopped{background:var(--dim)}
code{background:#1f1f1e;padding:1px 5px;border-radius:4px;font-size:12px}
</style></head><body><div class="wrap">
<h1>按钮派发本地任务</h1>
<div class="sub">局域网打开同一个按钮。点运行后，只在你这台电脑的 WorkBuddy 里执行，结果回到本页。</div>
<div id="bridge" class="sub">正在连接这台电脑的桥接…</div>

<div class="card">
  <label>目标任务（产物仍落在该任务的工作目录）</label>
  <select id="gwSel"></select>
  <label style="margin-top:12px">任务内容</label>
  <textarea id="prompt">在当前目录创建文件 hello.txt，内容写：由按钮派发的任务。只做这一件事。</textarea>
  <button id="go">运行</button>
  <div id="msg"></div>
  <div id="result" class="result"></div>
</div>

<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <label style="margin:0">最近派发的任务（点「全文」看完整回答，摘要只有一行）</label>
    <button class="mini" id="refresh">刷新</button>
  </div>
  <div id="jobs" style="margin-top:8px">加载中…</div>
</div>
</div>
<script>
const $ = s => document.querySelector(s);
const LOOPBACK = location.hostname === '127.0.0.1' || location.hostname === 'localhost'
  || location.hostname === '[::1]';
const BRIDGE = LOOPBACK ? '' : ('http://127.0.0.1:' + (location.port || '8799'));
let busy = false, gateways = [], lastJobId = '';

function bridgeNote(ok, text) {
  const el = $('#bridge');
  el.textContent = text;
  el.className = 'sub ' + (ok ? 'ok' : 'bad');
}

async function api(p, o) {
  let r;
  try { r = await fetch(BRIDGE + p, o); }
  catch (e) { return { offline: true, error: '连不上这台电脑的桥接' }; }
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return { raw: t, status: r.status }; }
}

async function loadGateways() {
  const r = await api('/api/gateways');
  if (!r || r.offline) {
    bridgeNote(false, '这台电脑还没桥接。请在本机运行：python test1.py --lan');
    gateways = [];
    $('#gwSel').innerHTML = '<option value="">（本机桥接未启动）</option>';
    return;
  }
  bridgeNote(true, '已连上这台电脑的桥接。运行结果会显示在本页，不会发到别人的电脑。');
  gateways = (r && r.gateways) || [];
  const sel = $('#gwSel');
  const keep = sel.value;
  if (!gateways.length) {
    sel.innerHTML = '<option value="">（没发现正在运行的 WorkBuddy 会话）</option>';
    return;
  }
  sel.innerHTML = gateways.map((g,i) =>
    '<option value="' + esc(g.url) + '" title="' + esc(g.cwd || '') + '">'
    + esc(g.title || g.cwd || '(未知任务)') + '</option>'
  ).join('');
  if (keep && gateways.some(g => g.url === keep)) sel.value = keep;
}

function fmtErr(v) {
  if (v == null || v === '') return '未知错误';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (typeof v.message === 'string' && v.message) return v.message;
    if (typeof v.error === 'string' && v.error) return v.error;
    if (v.error && typeof v.error === 'object' && typeof v.error.message === 'string') return v.error.message;
    if (typeof v.raw === 'string' && v.raw) return v.raw;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  return String(v);
}

async function dispatch() {
  if (busy) return;
  const gw = $('#gwSel').value;
  if (!gw) { $('#msg').textContent = '没有可用目标'; $('#msg').style.color='var(--err)'; return; }
  busy = true; $('#go').disabled = true;
  $('#msg').textContent = '派发中…'; $('#msg').style.color = 'var(--dim)';
  const r = await api('/api/dispatch', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ gateway: gw, prompt: $('#prompt').value }) });
  if (r && r.ok) {
    lastJobId = (r.job && r.job.id) || '';
    $('#msg').innerHTML = '已在这台电脑执行 → <code>' + esc(lastJobId) + '</code>';
    $('#msg').style.color = 'var(--ok)';
    $('#result').textContent = '执行中…';
    poll();
  } else if (r && r.offline) {
    $('#msg').textContent = '失败：这台电脑的桥接没开';
    $('#msg').style.color = 'var(--err)';
  } else {
    $('#msg').textContent = '失败：' + fmtErr(r && (r.error || r.raw || r));
    $('#msg').style.color = 'var(--err)';
  }
  busy = false; $('#go').disabled = false;
}

async function stopJob(gw, id) {
  await api('/api/stop', { method:'POST', headers:{'Content-Type':'application/json'},
                           body: JSON.stringify({ gateway: gw, id: id }) });
  poll();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmt(ts){ return ts ? new Date(ts).toLocaleTimeString('zh-CN') : ''; }

const fullCache = {};   // id -> 完整回答
const fullOpen = {};    // id -> 是否展开
let topFullId = '';     // 顶部结果区已经取过全文的那个 id

async function fetchFull(id) {
  const gw = $('#gwSel').value;
  const r = await api('/api/transcript?gateway=' + encodeURIComponent(gw)
                      + '&id=' + encodeURIComponent(id));
  if (r && r.ok) {
    return { ok: true, text: r.text || r.detail || '（没有文字结果）',
             chars: r.chars || 0, source: r.source || '-' };
  }
  return { ok: false, error: fmtErr(r && (r.error || r.raw || r)) };
}

async function loadFull(id) {
  const box = document.getElementById('full-' + id);
  if (!box) return;
  if (fullCache[id]) {
    fullOpen[id] = !fullOpen[id];
    box.style.display = fullOpen[id] ? 'block' : 'none';
    return;
  }
  fullOpen[id] = true;
  box.style.display = 'block';
  box.textContent = '取全文中…';
  const res = await fetchFull(id);
  if (res.ok) {
    fullCache[id] = res.text;
    box.textContent = '全文 ' + res.chars + ' 字（来源 ' + res.source + '）\n\n' + res.text;
  } else {
    box.textContent = '取全文失败：' + res.error;
    fullOpen[id] = false;
  }
}

function copyFull(id) {
  const text = fullCache[id];
  if (!text) { alert('先点「全文」取一次，再复制'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text);
  }
}

function fullBox(id) {
  const open = fullOpen[id] ? 'block' : 'none';
  const body = fullCache[id] ? esc(fullCache[id]) : '';
  return '<div class="full" id="full-' + esc(id) + '" style="display:' + open + '">'
    + body + '</div>';
}

async function fillTopFull(cur) {
  if (!cur || !cur.id || topFullId === cur.id) return;
  topFullId = cur.id;
  const res = await fetchFull(cur.id);
  if (res.ok) {
    fullCache[cur.id] = res.text;
    $('#result').textContent = '全文 ' + res.chars + ' 字（来源 ' + res.source + '）\n\n' + res.text;
  }
}

async function poll() {
  const gw = $('#gwSel').value;
  if (!gw) { $('#jobs').innerHTML = '<span style="color:var(--dim)">暂无</span>'; return; }
  const r = await api('/api/jobs?gateway=' + encodeURIComponent(gw));
  const list = (r && r.jobs) || [];
  if (lastJobId) {
    const cur = list.find(j => j.id === lastJobId);
    if (cur) {
      const st = cur.state || cur.status || '';
      const running = ['working','busy','active','pending'].includes(st) || cur.alive === true;
      if (!running && fullCache[cur.id]) {
        $('#result').textContent = '全文 ' + fullCache[cur.id].length + ' 字\n\n' + fullCache[cur.id];
      } else {
        $('#result').textContent = cur.detail
          || (st === 'done' ? '已完成，没有文本结果' : ('执行中… ' + st));
        if (!running) fillTopFull(cur);
      }
    }
  }
  $('#jobs').innerHTML = list.length ? list.map(j => {
    const st = j.state || j.status || '?';
    const running = ['working','busy','active','pending'].includes(st) || j.alive === true;
    return '<div class="job"><div class="top"><span class="name">'
      + '<span class="dot s-' + st + '"></span>' + (j.name || '(未命名)') + '</span>'
      + '<span style="white-space:nowrap;color:var(--dim);font-size:12px">' + st
      + ' · ' + fmt(j.updatedAt || j.startedAt) + '</span></div>'
      + '<div class="meta">' + esc(j.intent || '') + '</div>'
      + (j.detail ? '<div class="result">摘要：' + esc(j.detail) + '</div>' : '')
      + '<div class="meta">id ' + esc(j.id) + (j.pid ? ' · pid ' + esc(j.pid) : '')
      + ' · ' + esc(j.cwd || '') + '</div>'
      + '<div class="actions">'
      + '<button class="mini" onclick="loadFull(\'' + esc(j.id) + '\')">'
      + (fullOpen[j.id] ? '收起' : '全文') + '</button>'
      + '<button class="mini" onclick="copyFull(\'' + esc(j.id) + '\')">复制全文</button>'
      + (running ? '<button class="mini" onclick="stopJob(\'' + esc(gw) + '\',\'' + esc(j.id) + '\')">停止</button>' : '')
      + '</div>'
      + fullBox(j.id) + '</div>';
  }).join('') : '<span style="color:var(--dim)">暂无</span>';
}

$('#go').onclick = dispatch;
$('#refresh').onclick = poll;
$('#gwSel').onchange = function () {
  topFullId = '';
  $('#result').textContent = '';
  poll();
};
loadGateways(); poll();
setInterval(poll, 2500);
setInterval(loadGateways, 20000);
</script></body></html>
"""


def _host_of_origin(origin):
    try:
        from urllib.parse import urlparse
        return (urlparse(origin).hostname or "").strip("[]").lower()
    except Exception:
        return ""


def _origin_allowed(origin, pattern):
    """来源是否命中白名单条目。

    支持：`*`、完整来源精确匹配、`*.domain`（**端口无关**）。之前用字符串后缀比，
    带端口的来源（http://xx.stillgroup.net:3040）会漏掉，所以改成比 host。
    """
    if not pattern:
        return False
    if pattern == "*" or pattern == origin:
        return True
    try:
        from urllib.parse import urlparse
        op = urlparse(origin)
        pp = urlparse(pattern if "//" in pattern else "//" + pattern)
        oh = (op.hostname or "").strip("[]").lower()
        ph = (pp.hostname or "").strip("[]").lower()
        if not oh or not ph:
            return False
        if op.scheme and pp.scheme and op.scheme.lower() != pp.scheme.lower():
            return False
        if ph.startswith("*."):
            base = ph[2:]
            return oh == base or oh.endswith("." + base)
        return oh == ph and (op.port or 0) == (pp.port or 0)
    except Exception:
        return False


def _private_host(host):
    """本机或局域网地址。按钮页从这些地址打开时，允许它调用 127.0.0.1 上的桥接。"""
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    parts = host.split(".")
    if len(parts) != 4 or not all(p.isdigit() for p in parts):
        return False
    nums = [int(p) for p in parts]
    if any(n > 255 for n in nums):
        return False
    a, b = nums[0], nums[1]
    return a == 10 or (a == 192 and b == 168) or (a == 172 and 16 <= b <= 31)


class Handler(BaseHTTPRequestHandler):
    explicit_password = None  # 仅 --password；其余来源在每次请求时现查
    allowed_origin = None  # None = 不开 CORS（只允许本页同源调用）
    lan_mode = False  # 页面可从局域网打开；/api 仍只接受本机
    server_version = "TaskButton/1.0"

    def log_message(self, *a):
        pass

    def _from_this_pc(self):
        host = (self.client_address or ("",))[0]
        return host in ("127.0.0.1", "::1")

    def _cors(self):
        """按白名单回 CORS 头。默认不开, 避免任意网页跨源调用本服务派发任务。
        --lan 时额外允许从局域网页面调用本机 127.0.0.1。"""
        origin = self.headers.get("Origin") or ""
        allow = None
        if self.allowed_origin == "*":
            allow = "*"
        elif origin and self.allowed_origin:
            for pat in [x.strip() for x in self.allowed_origin.split(",") if x.strip()]:
                if _origin_allowed(origin, pat):
                    allow = origin
                    break
        if not allow and self.lan_mode and origin and _private_host(_host_of_origin(origin)):
            allow = origin
        if allow:
            self.send_header("Access-Control-Allow-Origin", allow)
            self.send_header("Access-Control-Allow-Headers",
                             "Content-Type, X-Task-Button, Authorization, "
                             "mcp-session-id, MCP-Protocol-Version")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Expose-Headers", "mcp-session-id")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")

    def _is_mcp_path(self):
        return self.path.split("?")[0].rstrip("/") == "/mcp"

    def _api_blocked(self):
        """--lan 时接口（含 /mcp）只接受本机和局域网私网地址。公网来源拒绝。"""
        if not (self.lan_mode and (self.path.startswith("/api/") or self._is_mcp_path())):
            return False
        host = (self.client_address or ("",))[0]
        if self._from_this_pc() or _private_host(host):
            return False
        self._send(403, json.dumps({"error": "只接受本机或局域网地址"}, ensure_ascii=False))
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(raw)
        except Exception:
            pass

    def _json(self, obj):
        self._send(200, json.dumps(obj, ensure_ascii=False))

    def _read(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception:
            return {}

    def _pick_gateway(self, want):
        return pick_gateway(want, self.explicit_password)

    def _mcp_send(self, payload):
        """MCP Streamable HTTP：客户端要 SSE 就按 SSE 回，否则回 JSON。"""
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        accept = (self.headers.get("Accept") or "").lower()
        sse_only = "text/event-stream" in accept and "application/json" not in accept
        if sse_only:
            body = b"event: message\ndata: " + raw + b"\n\n"
            ctype = "text/event-stream; charset=utf-8"
        else:
            body = raw
            ctype = "application/json; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Mcp-Session-Id", _MCP_SESSION_ID)
        if sse_only:
            self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _mcp_post(self):
        body = self._read()
        if isinstance(body, list):
            out = [r for r in (mcp_handle(m, self.explicit_password) for m in body) if r]
            if not out:
                return self._send(202, "")
            return self._mcp_send(out)
        result = mcp_handle(body, self.explicit_password)
        if result is None:  # 通知：按规范回 202，无响应体
            return self._send(202, "")
        self._mcp_send(result)

    def do_DELETE(self):
        if self._is_mcp_path():
            return self._send(200, json.dumps({"ok": True}))
        return self._send(404, json.dumps({"error": "not found"}))

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if self._is_mcp_path():
            # 不提供 SSE 长连接流，按规范回 405
            return self._send(405, json.dumps(
                {"error": "不提供 SSE 流；用 POST /mcp 调 JSON-RPC"}, ensure_ascii=False))
        if self._api_blocked():
            return

        if self.path.startswith("/api/gateways"):
            gws = resolve_gateways(self.explicit_password)
            return self._json(gateways_payload(gws))

        if self.path.startswith("/api/transcript"):
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            g = self._pick_gateway((q.get("gateway") or [None])[0])
            job_id = ((q.get("id") or [""])[0] or "").strip()
            if not g or not job_id:
                return self._json({"ok": False, "error": "参数不完整"})
            info = job_full_text(g, job_id)
            info["ok"] = True
            info["chars"] = len(info["text"])
            return self._json(info)

        if self.path.startswith("/api/jobs"):
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            g = self._pick_gateway((q.get("gateway") or [None])[0])
            if not g:
                return self._json({"jobs": [], "error": "没有可用网关", "gateway": None})
            st, body = http_json(g["url"], "/api/v1/jobs?all=1", password=g.get("password"))
            jobs = body.get("data", {}).get("jobs", []) if st == 200 else []
            return self._json({"gateway": g["url"], "jobs": jobs})

        return self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        if self._api_blocked():
            return
        if self._is_mcp_path():
            return self._mcp_post()
        if self.path == "/api/dispatch":
            p = self._read()
            g = self._pick_gateway(p.get("gateway"))
            if not g:
                return self._json({"ok": False, "error": "目标网关不可用（WorkBuddy 是否在运行？）"})
            ok, payload = dispatch_to_gateway(g, p.get("prompt") or "", p.get("name"),
                                              p.get("cwd"))
            return self._json(payload)

        if self.path == "/api/stop":
            p = self._read()
            g = self._pick_gateway(p.get("gateway"))
            if not g or not p.get("id"):
                return self._json({"ok": False, "error": "参数不完整"})
            st, body = http_json(g["url"], "/api/v1/jobs/%s/stop" % p["id"], method="POST",
                                 body={}, password=g.get("password"), timeout=30)
            return self._json({"ok": st == 200, "status": st, "result": body})

        return self._send(404, json.dumps({"error": "not found"}))


def _lan_ip():
    import socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return ""


def _start_hub_announce(hub, port):
    """每隔一段时间把本机局域网 IP 登记到 Flask 通讯。"""
    import socket
    import threading
    from urllib.parse import urlparse
    hub = (hub or "").strip().rstrip("/")
    parsed = urlparse(hub)
    host = (parsed.hostname or "").strip("[]")
    if parsed.scheme not in ("http", "https") or not _private_host(host):
        log("  [!] --hub 只接受局域网地址，已忽略")
        return
    ip = _lan_ip()
    if not ip:
        log("  [!] 没拿到本机局域网 IP，无法向 Flask 登记")
        return
    name = socket.gethostname()

    def loop():
        body = json.dumps({"ip": ip, "port": port, "name": name}).encode("utf-8")
        while True:
            try:
                req = urllib.request.Request(hub + "/api/register", data=body, method="POST")
                req.add_header("Content-Type", "application/json")
                urllib.request.urlopen(req, timeout=3).read()
            except Exception:
                pass
            time.sleep(10)

    threading.Thread(target=loop, daemon=True).start()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8799)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--lan", action="store_true",
                    help="开放到局域网。接口只接受本机和私网 IP，供 Flask 通讯按 IP 调用")
    ap.add_argument("--hub", default=None,
                    help="向 Flask 通讯登记本机 IP，例如 http://192.168.0.54:5000")
    ap.add_argument("--password", default=None)
    ap.add_argument("--allow-origin", default=None,
                    help="允许跨源调用本服务的来源, 用于把按钮嵌进你自己的网页/服务器上的脑图; "
                         "支持逗号分隔和 *.domain 通配; 也可以走环境变量 BRIDGE_ALLOW_ORIGIN；"
                         "都不给就只放行本机和局域网私网来源")
    args = ap.parse_args()
    if not args.allow_origin:
        args.allow_origin = (os.environ.get("BRIDGE_ALLOW_ORIGIN") or "").strip() or None

    if args.lan:
        args.host = "0.0.0.0"
    Handler.explicit_password = args.password
    Handler.allowed_origin = args.allow_origin
    Handler.lan_mode = args.lan

    found = candidate_passwords(args.password)
    log("=" * 60)
    log("  按钮派发本地任务 · 桥接服务")
    log("=" * 60)
    if found:
        log("  网关密码   已就绪（来源：%s）" % found[0][1])
    else:
        log("  [!] 没拿到网关密码，派发会返回 401。")
        log("      WorkBuddy 需要在运行；密码会从它的会话进程里读。")
        log("      也可以 --password，或在本目录建 gateway.json。")

    gws = resolve_gateways(args.password)
    log("  可用网关   %d 个" % len(gws))
    for g in gws[:6]:
        log("     %-24s %s" % (g["url"], g.get("title") or g["cwd"]))
    log("-" * 60)
    if args.lan:
        lan_ip = _lan_ip() or "本机IP"
        log("  局域网按钮  http://%s:%d/" % (lan_ip, args.port))
        log("  通讯地址    %s:%d  （Flask 用这个 IP 把任务送回这台电脑）" % (lan_ip, args.port))
        log("  任务接口    接受本机和局域网私网，公网地址会拒绝")
        if args.hub:
            log("  登记到      %s" % args.hub)
    else:
        log("  浏览器打开  http://%s:%d/" % (args.host, args.port))
    log("  跨源白名单  %s" % (args.allow_origin or "(只放行本机/私网来源)"))
    if args.lan and not args.allow_origin:
        log("  [!] 脑图如果部署在服务器上（公网域名），浏览器点运行会被 CORS 拦，")
        log("      要加：--allow-origin \"*.你的域名\" 或设环境变量 BRIDGE_ALLOW_ORIGIN")
    log("  MCP 链接    http://127.0.0.1:%d/mcp  （Streamable HTTP）" % args.port)
    log("  停止服务    Ctrl + C")
    log("=" * 60)

    if args.hub:
        global HUB_URL
        HUB_URL = args.hub
        _start_hub_announce(args.hub, args.port)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("\n已停止")


if __name__ == "__main__":
    main()
