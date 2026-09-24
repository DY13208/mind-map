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
import base64
import ctypes
import glob
import json
import mimetypes
import os
import re
import ssl
import threading
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
# 产物文件：任务输出里提到的文件，读出来给页面挂到脑图节点（挂附件）
#
# 只有落在「执行主机工作目录」或 BRIDGE_ARTIFACT_ROOTS 里的文件才允许读，
# 免得好心办坏事——被网页拿去读整台机器的文件。
# ---------------------------------------------------------------------------

ARTIFACT_MAX_BYTES = 20 * 1024 * 1024
ARTIFACT_MAX_FILES = 12
ARTIFACT_TEXT_LIMIT = 200000
ARTIFACT_EXT_RE = (
    "html?|htm|md|markdown|txt|csv|tsv|json|ya?ml|log|xml|"
    "xlsx?|xlsm|docx?|pptx?|pdf|zip|xmind|"
    "png|jpe?g|webp|gif|svg|mp4|mov"
)
_ABS_PATH_RE = re.compile(
    r"(?:[A-Za-z]:[\\/]|\\\\)[^\s\"'`，。；：、（）()\[\]【】《》<>|*?\n\r\t]*?"
    r"\.(?:" + ARTIFACT_EXT_RE + r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_REL_PATH_RE = re.compile(
    r"(?<![\w/\\.\-])[A-Za-z0-9_.\-\u4e00-\u9fff]+"
    r"(?:[\\/][A-Za-z0-9_.\-\u4e00-\u9fff]+)*"
    r"\.(?:" + ARTIFACT_EXT_RE + r")(?![A-Za-z0-9])",
)


def _clean_path_text(raw):
    return (raw or "").strip().strip("`\"'“”‘’（）()《》<>，。；、").rstrip(".,;:)]）】").strip()


ARTIFACT_FILTER = (os.environ.get("BRIDGE_ARTIFACT_FILTER") or "1").lower() not in ("0", "false", "no", "off")
ARTIFACT_DIR_HINTS = (
    "output", "outputs", "out", "dist", "release", "export", "exports",
    "report", "reports", "deliverable", "deliverables", "artifact", "artifacts",
    "交付", "产物", "输出", "结果", "生成", "报表", "报告",
)
# 源码目录与代码类扩展名不算产物（除非就在产物目录里）
ARTIFACT_DIR_BLOCK = (
    "node_modules", ".git", "src", "bin", "scripts", "__pycache__", "vendor",
)
ARTIFACT_CODE_EXT = (
    ".js", ".mjs", ".cjs", ".ts", ".vue", ".json", ".scss", ".less", ".css",
    ".map", ".lock", ".env", ".py", ".pyc", ".toml", ".ini", ".yml", ".yaml",
)
ARTIFACT_LINE_HINTS = (
    "交付", "产物", "产出", "生成", "落地", "文件清单", "产物清单", "输出文件",
    "交付物", "deliverable", "artifact", "output",
)


def _line_at(text, pos):
    start = text.rfind("\n", 0, pos) + 1
    end = text.find("\n", pos)
    return text[start:end if end >= 0 else len(text)]


def _looks_like_artifact(real, line):
    parts = [p.lower() for p in os.path.normpath(real).split(os.sep)[:-1]]
    if any(p in ARTIFACT_DIR_HINTS for p in parts):
        return True
    if any(p in ARTIFACT_DIR_BLOCK for p in parts):
        return False
    if os.path.splitext(real)[1].lower() in ARTIFACT_CODE_EXT:
        return False
    low = (line or "").lower()
    return any(h in low for h in ARTIFACT_LINE_HINTS)


def artifact_roots(gateways):
    """允许读取的目录白名单：执行主机的工作目录 + BRIDGE_ARTIFACT_ROOTS（分号分隔）。"""
    roots = []
    for g in gateways or []:
        cwd = (g.get("cwd") or "").strip()
        if cwd and os.path.isdir(cwd):
            roots.append(os.path.realpath(cwd))
    for item in (os.environ.get("BRIDGE_ARTIFACT_ROOTS") or "").split(";"):
        item = item.strip()
        if item and os.path.isdir(item):
            roots.append(os.path.realpath(item))
    out = []
    for r in roots:
        if r not in out:
            out.append(r)
    return out


def _path_in_roots(real, roots):
    if not roots:
        return False
    low = os.path.normcase(os.path.realpath(real))
    for root in roots:
        r = os.path.normcase(os.path.realpath(root)).rstrip("\\/")
        if low == r or low.startswith(r + os.sep):
            return True
    return False


def resolve_artifact_path(raw, cwd, roots):
    """把输出里的一段文字解析成真实文件路径，(路径, 失败原因)。"""
    text = _clean_path_text(raw)
    if not text:
        return None, "路径为空"
    if re.match(r"^[A-Za-z]:[\\/]", text) or text.startswith("\\\\") or text.startswith("//"):
        candidate = os.path.normpath(text)
    else:
        if not cwd:
            return None, "只有相对路径，且执行主机没有工作目录"
        candidate = os.path.normpath(os.path.join(cwd, text.replace("/", os.sep)))
    try:
        real = os.path.realpath(candidate)
    except Exception as err:
        return None, "路径解析失败：%s" % err
    if not os.path.isfile(real):
        return None, "文件不存在"
    if not _path_in_roots(real, roots):
        return None, "不在允许读取的目录内"
    return real, ""


def read_artifact(real, with_content=True):
    """读一个产物文件，(信息, 出错原因)。"""
    info = {
        "path": real,
        "name": os.path.basename(real),
        "size": os.path.getsize(real),
        "mime": mimetypes.guess_type(real)[0] or "application/octet-stream",
        "exists": True,
    }
    if not with_content:
        return info, ""
    if info["size"] > ARTIFACT_MAX_BYTES:
        return info, "文件超过 %d MB，未带回内容" % (ARTIFACT_MAX_BYTES // 1024 // 1024)
    try:
        with open(real, "rb") as fh:
            info["base64"] = base64.b64encode(fh.read()).decode("ascii")
    except Exception as err:
        return info, "读取失败：%s" % err
    return info, ""


def extract_artifact_paths(text, cwd, roots, limit=ARTIFACT_MAX_FILES * 3):
    """从任务输出里挑出真实存在的产物文件。

    绝对路径、相对路径都过一遍「像不像产物」：
    - 在 output/dist/交付 之类目录下 → 收；
    - 在 src/bin/node_modules 之类源码目录下，或扩展名是 .js/.vue/.json 这类代码文件 → 丢；
    - 其余看同行有没有「交付/产物/生成/落地」字样。
    否则 `web/public/templates/xxx.json` 这种正文引用也会被当成产物挂上去。
    设 BRIDGE_ARTIFACT_FILTER=0 可关掉这层过滤。
    """
    text = text or ""
    found = []
    seen = set()

    def add(raw, line):
        real, _why = resolve_artifact_path(raw, cwd, roots)
        if not real:
            return
        if ARTIFACT_FILTER and not _looks_like_artifact(real, line):
            return
        key = os.path.normcase(real)
        if key in seen:
            return
        seen.add(key)
        found.append(real)

    for m in _ABS_PATH_RE.finditer(text):
        add(m.group(0), _line_at(text, m.start()))
    if cwd:
        for m in _REL_PATH_RE.finditer(text):
            add(m.group(0), _line_at(text, m.start()))
    return found[:limit]


def read_artifacts_for_gateway(g, paths, with_content=True, cwd_override=""):
    cwd = (cwd_override or g.get("cwd") or "").strip()
    roots = artifact_roots([g])
    files = []
    for raw in (paths or [])[:ARTIFACT_MAX_FILES * 2]:
        real, why = resolve_artifact_path(raw, cwd, roots)
        if not real:
            files.append({
                "path": str(raw),
                "name": os.path.basename(str(raw)),
                "exists": False,
                "error": why,
            })
            continue
        item, err = read_artifact(real, with_content=with_content)
        if err:
            item["error"] = err
        files.append(item)
    return {"ok": True, "cwd": cwd, "roots": roots, "files": files}


def job_artifacts(g, job_id, with_content=True):
    """一个任务产出的文件清单：从它的完整回答里解析路径 + 校验存在 + 可选带内容。"""
    info = job_full_text(g, job_id)
    job = info.get("job") or {}
    cwd = (job.get("cwd") or g.get("cwd") or "").strip()
    text = info.get("text") or ""
    roots = artifact_roots([dict(g, cwd=cwd)])
    paths = extract_artifact_paths(text, cwd, roots)
    files = []
    for real in paths:
        item, err = read_artifact(real, with_content=with_content)
        if err:
            item["error"] = err
        files.append(item)
    return {
        "ok": True,
        "job": job,
        "cwd": cwd,
        "roots": roots,
        "filter": ARTIFACT_FILTER,
        "source": info.get("source") or "",
        "chars": len(text),
        "text": text[:ARTIFACT_TEXT_LIMIT],
        "truncated": len(text) > ARTIFACT_TEXT_LIMIT,
        "files": files,
    }


# ---------------------------------------------------------------------------
# 远程 mind-map MCP（客户端）：把附件经 MCP 挂回脑图
#
# 前端上传附件原本要经页面同域的 /api/attachments/resumable 与
# /api/files/<room>/attachments（nginx → 协同服务 1234）。服务器部署时这条路
# 可能不通；走 MCP 的 upload_attachment 是官方同效路径（节点上一样出现回形针）。
#
# 配置（优先环境变量，缺省从 ~/.workbuddy/mcp.json 的 mind-map 条目取）：
#   BRIDGE_MCP_URL / BRIDGE_MCP_TOKEN   MCP 地址与 Bearer token
#   BRIDGE_MCP_INSECURE=1               跳过证书校验（自签证书时用）
#   BRIDGE_ATTACH=0                     关掉这条通道，前端会退回协同服务上传
# ---------------------------------------------------------------------------

REMOTE_MCP_URL = (os.environ.get("BRIDGE_MCP_URL") or "").strip()
REMOTE_MCP_TOKEN = (os.environ.get("BRIDGE_MCP_TOKEN") or "").strip()
REMOTE_MCP_INSECURE = (os.environ.get("BRIDGE_MCP_INSECURE") or "0").lower() not in (
    "0", "false", "no", "off")
REMOTE_MCP_ENABLED = (os.environ.get("BRIDGE_ATTACH") or "1").lower() not in (
    "0", "false", "no", "off")
REMOTE_MCP_TIMEOUT = int(os.environ.get("BRIDGE_MCP_TIMEOUT") or "120")
ATTACH_MAX_BYTES = 20 * 1024 * 1024
ATTACH_TEXT_KEEP = 2400

# 注意用 RLock：会话过期时 remote_mcp_call 会递归重试一次，普通 Lock 会自锁
_remote_mcp = {"session": "", "lock": threading.RLock()}


def remote_mcp_config():
    """MCP 地址与 token：环境变量优先，其次 ~/.workbuddy/mcp.json 里的 mind-map"""
    url, token = REMOTE_MCP_URL, REMOTE_MCP_TOKEN
    if url and token:
        return url, token
    try:
        path = os.path.join(WORKBUDDY_DIR, "mcp.json")
        with open(path, "r", encoding="utf-8") as fh:
            entry = ((json.load(fh).get("mcpServers") or {}).get("mind-map") or {})
        url = url or (entry.get("url") or "").strip()
        token = token or ((entry.get("headers") or {}).get("Authorization") or "").strip()
    except Exception:
        pass
    return url, token


def remote_mcp_ready():
    if not REMOTE_MCP_ENABLED:
        return False
    url, token = remote_mcp_config()
    return bool(url and token)


def _remote_mcp_post(payload, timeout=None):
    url, token = remote_mcp_config()
    if not url:
        raise RuntimeError("没有配置 MCP 地址（BRIDGE_MCP_URL 或 mcp.json 的 mind-map）")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if token:
        headers["Authorization"] = token if token.lower().startswith("bearer ") else "Bearer " + token
    sid = _remote_mcp.get("session")
    if sid:
        headers["mcp-session-id"] = sid
    req = urllib.request.Request(
        url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers, method="POST")
    ctx = None
    if REMOTE_MCP_INSECURE:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=timeout or REMOTE_MCP_TIMEOUT, context=ctx) as r:
        new_sid = r.headers.get("mcp-session-id")
        if new_sid:
            _remote_mcp["session"] = new_sid
        return r.read().decode("utf-8", "replace")


def _remote_mcp_parse(raw):
    """MCP 回包可能是纯 JSON，也可能是 SSE（data: {...}）"""
    text = (raw or "").strip()
    if not text:
        return None
    if text.startswith("{"):
        try:
            return json.loads(text)
        except Exception:
            return None
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        chunk = line[5:].strip()
        if not chunk:
            continue
        try:
            return json.loads(chunk)
        except Exception:
            continue
    return None


def _remote_mcp_rpc(method, params=None, notify=False, timeout=None):
    body = {"jsonrpc": "2.0", "method": method}
    if not notify:
        body["id"] = int(time.time() * 1000) % 1000000
    if params is not None:
        body["params"] = params
    return _remote_mcp_parse(_remote_mcp_post(body, timeout))


def remote_mcp_init():
    res = _remote_mcp_rpc("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "workbuddy-bridge", "version": "1.0"},
    })
    if not res or "result" not in res:
        return False, json.dumps(res or {}, ensure_ascii=False)[:200]
    _remote_mcp_rpc("notifications/initialized", {}, notify=True)
    return True, ""


def remote_mcp_call(tool, args, timeout=None, retry_session=True):
    """调一个 MCP 工具；会话过期（-32001）自动重连一次。"""
    with _remote_mcp["lock"]:
        if not _remote_mcp.get("session"):
            ok, err = remote_mcp_init()
            if not ok:
                return False, "MCP 握手失败：" + (err or "无响应")
        res = _remote_mcp_rpc("tools/call", {"name": tool, "arguments": args}, timeout=timeout)
        if res is None:
            return False, "MCP 无响应（网络或证书问题）"
        if "error" in res:
            err = res["error"] or {}
            msg = err.get("message") if isinstance(err, dict) else str(err)
            code = err.get("code") if isinstance(err, dict) else ""
            expired = code == -32001 or "session" in str(msg).lower()
            if expired and retry_session:
                _remote_mcp["session"] = ""
                return remote_mcp_call(tool, args, timeout=timeout, retry_session=False)
            return False, "%s（%s）" % (msg, code)
        content = (res.get("result") or {}).get("content") or []
        text = ""
        if content and isinstance(content[0], dict):
            text = content[0].get("text") or ""
        if (res.get("result") or {}).get("isError"):
            return False, (text or "MCP 工具返回错误")[:300]
        try:
            return True, json.loads(text)
        except Exception:
            return True, {"__text__": text}


# MCP 的英文报错翻成人能看的话
def friendly_attach_error(msg):
    low = str(msg).lower()
    if "not found" in low or "不存在" in str(msg) or "找不到" in str(msg):
        return "节点在服务端还找不到（刚建的节点可能还没同步，或 uid 不对）"
    if "authorit" in low or "permission" in low or "forbidden" in low or "401" in low or "403" in low:
        return "没有权限（检查 MCP token 是否还有效）"
    if "session" in low:
        return "MCP 会话失效（会自动重连，仍失败请重试）"
    if "invalid arguments" in low:
        return "MCP 参数被拒：" + str(msg)[:200]
    return str(msg)[:300]


# 只有「节点还没同步到服务端」这类错误值得重试；参数错、权限错重试也没用
RETRY_ERROR_HINTS = ("not found", "不存在", "找不到", "no node", "unknown node", "node_uid")


def remote_mcp_upload(room_key, node_uid, name, mime, b64, confirm=True, retries=3):
    """单个文件挂到节点上。节点刚建好时服务端可能还没同步，这种情况等一会儿重试。"""
    args = {
        "room_key": room_key,
        "node": node_uid,
        "file_name": name,
        "content_base64": b64,
        "confirm_sop_change": bool(confirm),
    }
    if mime:
        args["mime_type"] = mime
    last = ""
    for i in range(max(1, retries)):
        ok, res = remote_mcp_call("upload_attachment", args)
        if ok and isinstance(res, dict) and res.get("ok"):
            return True, (res.get("attachment") or {})
        last = res if isinstance(res, str) else json.dumps(res, ensure_ascii=False)[:300]
        retryable = any(hint in str(last).lower() for hint in RETRY_ERROR_HINTS)
        if not retryable or i + 1 >= retries:
            break
        time.sleep(1.0)
    return False, last or "upload_attachment 失败"


def attach_files_to_map(room_key, node_uid, files, confirm=True):
    """把一批文件（{name, mimeType, base64}）经 MCP 挂到脑图节点上。"""
    results = []
    for item in files or []:
        name = str(item.get("name") or "").strip()
        b64 = item.get("base64") or ""
        if not name or not b64:
            results.append({"name": name, "ok": False, "error": "缺少 name 或 base64"})
            continue
        mime = str(item.get("mimeType") or "").strip() or (
            mimetypes.guess_type(name)[0] or "")
        size = len(b64) * 3 // 4
        if size > ATTACH_MAX_BYTES:
            results.append({"name": name, "ok": False,
                            "error": "超过 %dMB，没挂" % (ATTACH_MAX_BYTES // 1024 // 1024)})
            continue
        ok, info = remote_mcp_upload(room_key, node_uid, name, mime, b64, confirm)
        if not ok:
            results.append({"name": name, "ok": False,
                            "error": friendly_attach_error(info)})
            continue
        text = info.get("extractedText") or ""
        results.append({
            "name": name,
            "ok": True,
            "attachmentId": info.get("id") or "",
            "fileName": info.get("fileName") or name,
            "mimeType": info.get("mimeType") or mime,
            "status": info.get("status") or "",
            "byteSize": info.get("byteSize") or size,
            "extractedText": text[:ATTACH_TEXT_KEEP],
        })
    return results


# ---------------------------------------------------------------------------
# MCP 服务端（Streamable HTTP，零依赖）：桥接自己也是一条 MCP 链接
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
            "name": "job_artifacts",
            "description": "列出某个任务产出的文件（从它的完整回答里解析路径并校验存在）。"
                           "content=true 时连同文件内容（base64）一起返回，便于挂到脑图节点。"
                           "只允许读取执行主机工作目录内的文件。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "任务 id"},
                    "gateway": {"type": "string", "description": "该任务所在会话，不填用首个可用"},
                    "content": {"type": "boolean", "description": "是否带回文件内容，默认 false"},
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

    if name == "job_artifacts":
        job_id = (args.get("id") or "").strip()
        if not job_id:
            return "id 不能为空", True
        g = pick_gateway(args.get("gateway"), explicit_password)
        if not g:
            return "本机没有可用的 WorkBuddy 会话", True
        info = job_artifacts(g, job_id, bool(args.get("content", False)))
        info["gateway"] = g["url"]
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
      border-radius:6px;font-size:12.5px;line-height:1.65;
      word-break:break-word;max-height:380px;overflow:auto}
.full .head,#result .head{color:var(--dim);font-size:12px;margin-bottom:6px}
#result{max-height:420px;overflow:auto;background:#1f1f1e;border:1px solid var(--line);
        border-radius:8px;padding:10px;font-size:12.5px;line-height:1.65;word-break:break-word}
#result:empty{display:none}
/* Markdown 渲染后的排版（.full / #result 里） */
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{margin:12px 0 6px;font-weight:600;line-height:1.35}
.md h1{font-size:15.5px}.md h2{font-size:14.5px}.md h3{font-size:13.5px}.md h4,.md h5,.md h6{font-size:13px}
.md p{margin:0 0 8px}
.md ul,.md ol{margin:0 0 8px;padding-left:20px}
.md li{margin:2px 0}
.md pre{margin:8px 0;padding:10px;background:#141618;border-radius:6px;overflow:auto}
.md pre code{background:transparent;padding:0}
.md code{background:#2a2a28;padding:1px 4px;border-radius:3px;font-family:Consolas,'SF Mono',monospace}
.md table{width:100%;margin:8px 0;border-collapse:collapse;font-size:12px}
.md th,.md td{padding:4px 7px;border:1px solid var(--line);text-align:left;
      vertical-align:top;word-break:break-word}
.md th{background:#2a2a28;font-weight:600}
.md blockquote{margin:8px 0;padding:4px 10px;border-left:3px solid var(--line);color:var(--dim)}
.md hr{margin:10px 0;border:0;border-top:1px solid var(--line)}
.md a{color:var(--accent)}
.md img{max-width:100%}
.md > :first-child{margin-top:0}
.md > :last-child{margin-bottom:0}
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

// ---- 轻量 Markdown 渲染（先 esc 再套格式，不引外部库）----
function mdInline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return t;
}
function mdRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(s => s.trim());
}
function mdToHtml(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0, list = null, para = [];
  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
      para = [];
    }
  };
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {                       // 围栏代码块
      flushPara(); closeList();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    if (/\|/.test(line) && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]*-[\s:|-]*\|?[\s:|-]*$/.test(lines[i + 1])) {   // 表格
      flushPara(); closeList();
      const head = mdRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) { rows.push(mdRow(lines[i])); i += 1; }
      out.push('<table><thead><tr>' + head.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);     // 标题
    if (h) {
      flushPara(); closeList();
      out.push('<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>');
      i += 1; continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); i += 1; continue; }
    if (/^\s*>\s?/.test(line)) {                   // 引用
      flushPara(); closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push('<blockquote>' + mdInline(buf.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
      continue;
    }
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);   // 列表
    if (li) {
      flushPara();
      const kind = /^\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== kind) { closeList(); out.push('<' + kind + '>'); list = kind; }
      out.push('<li>' + mdInline(li[2]) + '</li>');
      i += 1; continue;
    }
    if (!line.trim()) { flushPara(); closeList(); i += 1; continue; }
    para.push(line); i += 1;
  }
  flushPara(); closeList();
  return out.join('\n');
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
    box.className = 'full md';
    box.innerHTML = '<div class="head">全文 ' + res.chars + ' 字（来源 ' + esc(res.source) + '）</div>'
      + mdToHtml(res.text);
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
  const body = fullCache[id]
    ? '<div class="head">全文 ' + fullCache[id].length + ' 字</div>' + mdToHtml(fullCache[id])
    : '';
  return '<div class="full md" id="full-' + esc(id) + '" style="display:' + open + '">'
    + body + '</div>';
}

async function fillTopFull(cur) {
  if (!cur || !cur.id || topFullId === cur.id) return;
  topFullId = cur.id;
  const res = await fetchFull(cur.id);
  if (res.ok) {
    fullCache[cur.id] = res.text;
    const box = $('#result');
    box.className = 'result md';
    box.innerHTML = '<div class="head">全文 ' + res.chars + ' 字（来源 ' + esc(res.source) + '）</div>'
      + mdToHtml(res.text);
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
        const box = $('#result');
        box.className = 'result md';
        box.innerHTML = '<div class="head">全文 ' + fullCache[cur.id].length + ' 字</div>'
          + mdToHtml(fullCache[cur.id]);
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

        if self.path.startswith("/api/job-artifacts"):
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            g = self._pick_gateway((q.get("gateway") or [None])[0])
            job_id = ((q.get("id") or [""])[0] or "").strip()
            if not g or not job_id:
                return self._json({"ok": False, "error": "参数不完整"})
            want = ((q.get("content") or ["1"])[0] or "1").lower()
            return self._json(job_artifacts(g, job_id, want not in ("0", "false", "no")))

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

        if self.path == "/api/attach":
            p = self._read()
            room = str(p.get("roomKey") or "").strip()
            node = str(p.get("nodeUid") or "").strip()
            files = p.get("files") or []
            if not remote_mcp_ready():
                return self._json({
                    "ok": False,
                    "error": "桥接没配 MCP 附件通道（BRIDGE_MCP_URL/BRIDGE_MCP_TOKEN，"
                             "或 ~/.workbuddy/mcp.json 里的 mind-map）",
                })
            if not room or not node:
                return self._json({"ok": False, "error": "缺少 roomKey / nodeUid"})
            if not files:
                return self._json({"ok": False, "error": "没有要挂的文件"})
            try:
                results = attach_files_to_map(room, node, files,
                                              p.get("confirmSopChange", True))
            except Exception as e:
                return self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})
            ok_files = [f for f in results if f.get("ok")]
            return self._json({
                "ok": bool(ok_files),
                "via": "mcp",
                "attachments": results,
                "failed": [f for f in results if not f.get("ok")],
            })

        if self.path == "/api/artifacts":
            p = self._read()
            g = self._pick_gateway(p.get("gateway"))
            if not g:
                return self._json({"ok": False, "error": "目标网关不可用（WorkBuddy 是否在运行？）"})
            return self._json(read_artifacts_for_gateway(
                g, p.get("paths") or [], p.get("content", True), p.get("cwd") or ""))

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


def _start_hub_announce(hub, port, allow_public=False):
    """每隔一段时间把本机局域网 IP 登记到通讯页。

    默认只认局域网地址（通讯页一般就在旁边那台机器上）。通讯页搬到服务器上以后，
    要用公网/https 地址登记就显式加 --allow-public-hub —— 那是把本机局域网 IP 和
    主机名报给对方，值得多按一次开关。
    """
    import socket
    import threading
    from urllib.parse import urlparse
    hub = (hub or "").strip().rstrip("/")
    parsed = urlparse(hub)
    host = (parsed.hostname or "").strip("[]")
    if parsed.scheme not in ("http", "https"):
        log("  [!] --hub 只接受 http/https 地址，已忽略")
        return
    if not _private_host(host) and not allow_public:
        log("  [!] --hub 是公网地址，已忽略（要登记到服务器上的通讯页就加 --allow-public-hub）")
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
                    help="向通讯页登记本机 IP，例如 http://192.168.0.54:5000 "
                         "或 https://mind.example.com/jobhub")
    ap.add_argument("--allow-public-hub", action="store_true",
                    help="允许 --hub 用公网地址（通讯页部署在服务器上时用；"
                         "会把本机局域网 IP 和主机名报给对方）")
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
    mcp_url, _mcp_token = remote_mcp_config()
    if REMOTE_MCP_ENABLED and mcp_url:
        log("  附件通道    经 MCP 挂回脑图 → %s" % mcp_url)
    elif REMOTE_MCP_ENABLED:
        log("  附件通道    未配置（设 BRIDGE_MCP_URL/BRIDGE_MCP_TOKEN，"
            "或让 ~/.workbuddy/mcp.json 里有 mind-map）")
    else:
        log("  附件通道    已关闭（BRIDGE_ATTACH=0），前端会退回协同服务上传")
    log("  停止服务    Ctrl + C")
    log("=" * 60)

    if args.hub:
        global HUB_URL
        HUB_URL = args.hub
        _start_hub_announce(args.hub, args.port, args.allow_public_hub)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("\n已停止")


if __name__ == "__main__":
    main()
