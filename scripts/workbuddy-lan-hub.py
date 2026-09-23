#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
局域网通讯

每台电脑运行自己的桥接：
    python test1.py --lan --hub http://<本页IP>:5000

本页用 Flask 记下它们的 IP。点运行时，按选中的 IP 把任务送到那台电脑的
WorkBuddy，执行结果再回到这个页面。

    python comm.py
    python comm.py --port 5000
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

from flask import Flask, jsonify, request

from test1 import _lan_ip, _private_host

HERE = os.path.dirname(os.path.abspath(__file__))
PEERS_PATH = os.path.join(HERE, "peers.json")
ONLINE_SEC = 30
_lock = threading.Lock()

app = Flask(__name__)


def _load():
    if not os.path.isfile(PEERS_PATH):
        return {}
    try:
        with open(PEERS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    out = {}
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and item.get("ip"):
                out[_key(item["ip"], item.get("port"))] = item
    return out


def _save(peers):
    rows = list(peers.values())
    tmp = PEERS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PEERS_PATH)


def _key(ip, port):
    return "%s:%s" % (ip, int(port or 8799))


def _public(item):
    seen = item.get("seen") or 0
    return {
        "name": item.get("name") or item.get("ip"),
        "ip": item.get("ip"),
        "port": int(item.get("port") or 8799),
        "online": bool(seen) and (time.time() - seen) <= ONLINE_SEC,
        "manual": bool(item.get("manual")),
    }


_peers = _load()


def _upsert(ip, port, name, manual):
    if not _private_host(ip):
        return None, "只接受局域网 IP"
    try:
        port = int(port or 8799)
    except (TypeError, ValueError):
        return None, "端口不对"
    if not 1 <= port <= 65535:
        return None, "端口不对"
    now = time.time()
    with _lock:
        cur = _peers.get(_key(ip, port), {})
        cur.update({
            "ip": ip,
            "port": port,
            "name": (name or cur.get("name") or ip).strip(),
            "seen": now,
            "manual": bool(manual or cur.get("manual")),
        })
        _peers[_key(ip, port)] = cur
        _save(_peers)
        return _public(cur), None


def _bridge_call(ip, port, path, method="GET", body=None, timeout=20):
    if not _private_host(ip):
        return 400, {"error": "只接受局域网 IP"}
    try:
        port = int(port or 8799)
    except (TypeError, ValueError):
        return 400, {"error": "端口不对"}
    url = "http://%s:%d%s" % (ip, port, path)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            code = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        code = e.code
    except Exception as e:
        return 502, {"error": "连不上 %s:%s（那台电脑要先运行 python test1.py --lan）" % (ip, port),
                     "detail": str(e)}
    try:
        return code, json.loads(raw or "{}")
    except Exception:
        return code, {"raw": raw}


PAGE = r"""<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>局域网通讯</title>
<style>
:root{--bg:#1b1b1a;--card:#262624;--line:#3a3a37;--fg:#e8e6e1;--dim:#a3a09a;
      --accent:#7fa8e8;--ok:#7bc99a;--warn:#e0a94f;--err:#e08a8a}
*{box-sizing:border-box}
body{margin:0;padding:28px;background:var(--bg);color:var(--fg);
     font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:840px;margin:0 auto}
h1{font-size:18px;font-weight:500;margin:0 0 4px}
.sub{color:var(--dim);font-size:13px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
      padding:18px;margin-bottom:16px}
label{display:block;font-size:13px;color:var(--dim);margin-bottom:6px}
textarea,input,select{width:100%;background:#1f1f1e;border:1px solid var(--line);border-radius:8px;
      color:var(--fg);font:13px/1.6 inherit;padding:10px;outline:none}
textarea{min-height:84px;resize:vertical}
textarea:focus,input:focus,select:focus{border-color:var(--accent)}
.row{display:flex;gap:8px}
.row input{flex:1}
button{margin-top:14px;width:100%;padding:13px;border:0;border-radius:9px;cursor:pointer;
      background:var(--accent);color:#10131a;font-size:15px;font-weight:500}
button.mini{margin:0;width:auto;padding:8px 12px;font-size:13px;background:#3a3a37;color:var(--fg)}
button:disabled{opacity:.5;cursor:default}
.peer{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--line)}
.peer:first-child{border-top:0}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:var(--dim)}
.on{background:var(--ok)}.off{background:var(--err)}
#msg{margin-top:12px;font-size:13px;min-height:20px}
.ok{color:var(--ok)}.bad{color:var(--err)}
.result{margin-top:8px;white-space:pre-wrap;word-break:break-word}
code{background:#1f1f1e;padding:1px 5px;border-radius:4px;font-size:12px}
</style></head><body><div class="wrap">
<h1>局域网通讯</h1>
<div class="sub">不用选电脑。谁点运行，就用谁这台电脑的 IP，并在它最早开始的那条 WorkBuddy 任务里执行，结果回到本页。</div>

<div class="card">
  <label>在线电脑</label>
  <div id="peers">加载中…</div>
  <div class="row" style="margin-top:12px">
    <input id="name" placeholder="名称，例如 前台">
    <input id="ip" placeholder="局域网 IP，例如 192.168.0.54">
    <input id="port" placeholder="8799" style="max-width:90px" value="8799">
    <button class="mini" id="add" type="button">添加</button>
  </div>
</div>

<div class="card">
  <div id="auto" class="sub">正在识别这台电脑…</div>
  <label>任务内容</label>
  <textarea id="prompt">在当前目录创建文件 hello.txt，内容写：由局域网通讯派发。只做这一件事。</textarea>
  <button id="go" type="button">运行</button>
  <div id="msg"></div>
  <div id="result" class="result"></div>
</div>
</div>
<script>
const $ = s => document.querySelector(s);
let busy = false, lastJob = '', lastTarget = null, sawRunning = false;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function api(p, o) {
  const r = await fetch(p, o);
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return { raw: t, status: r.status }; }
}
async function loadPeers() {
  const r = await api('/api/peers');
  const peers = (r && r.peers) || [];
  const box = $('#peers');
  if (!peers.length) {
    box.innerHTML = '<span style="color:var(--dim)">还没有电脑。每台让 WorkBuddy 启动桥接后，这里会出现它的 IP。</span>';
    return;
  }
  box.innerHTML = peers.map(p =>
    '<div class="peer"><span><span class="dot ' + (p.online ? 'on' : 'off') + '"></span>'
    + esc(p.name) + ' · ' + esc(p.ip) + ':' + p.port
    + (p.online ? ' · 在线' : ' · 未登记心跳') + '</span>'
    + '<button class="mini" type="button" onclick="dropPeer(\'' + esc(p.ip) + '\',' + p.port + ')">移除</button></div>'
  ).join('');
}
async function loadMe() {
  const r = await api('/api/me');
  const el = $('#auto');
  if (!r || r.error) {
    el.className = 'sub bad';
    el.textContent = (r && r.ip ? r.ip + '：' : '') + ((r && r.error) || '没识别到这台电脑');
    return;
  }
  el.className = 'sub ok';
  el.textContent = '这台电脑 ' + r.ip + ' · 将使用最早开始的任务：' + (r.task && r.task.title || '')
    + (r.bridgeOld ? '。这台桥接是旧版，跑完后的结果传不回来，请重新拷贝技能并再启动一次。' : '');
}
async function addPeer() {
  const r = await api('/api/peers', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:$('#name').value, ip:$('#ip').value.trim(), port:$('#port').value || 8799, manual:true})});
  if (!r || r.error) { alert((r && r.error) || '添加失败'); return; }
  $('#name').value = ''; $('#ip').value = '';
  await loadPeers(); await loadMe();
}
async function dropPeer(ip, port) {
  await api('/api/peers', {method:'DELETE', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ip:ip, port:port})});
  await loadPeers(); await loadMe();
}
async function runTask() {
  if (busy) return;
  busy = true; $('#go').disabled = true;
  $('#msg').textContent = '正在发给这台电脑…'; $('#msg').style.color = 'var(--dim)';
  $('#result').textContent = '';
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

  const r = await api('/api/dispatch', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({prompt: $('#prompt').value})});
  if (r && r.ok) {
    lastJob = (r.job && r.job.id) || '';
    lastTarget = {ip: r.ip, port: r.port, gateway: r.gateway};
    $('#msg').innerHTML = '已开始。正在这台电脑 <code>' + esc(r.ip) + '</code> 的「' + esc(r.taskTitle || '') + '」上执行';
    $('#msg').style.color = 'var(--warn, #e0a94f)';
    $('#result').textContent = '已开始，正在执行…';
    poll();
  } else {
    $('#msg').textContent = '失败：' + fmtErr(r && (r.error || r.raw));
    $('#msg').style.color = 'var(--err)';
  }
  busy = false; $('#go').disabled = false;
}
function jobText(cur) {
  let detail = (cur && cur.detail) || '';
  if (detail.slice(0, 7).toLowerCase() === 'result:') detail = detail.slice(7).trim();
  return detail;
}
function showJob(cur) {
  const st = (cur && (cur.state || cur.status)) || '';
  const running = ['working', 'busy', 'active'].includes(st) || cur.alive === true;
  const failed = st === 'failed';
  const stopped = st === 'stopped';
  const detail = jobText(cur);
  if (running) {
    sawRunning = true;
    const waited = cur.startedAt ? Math.max(0, Math.round((Date.now() - cur.startedAt) / 1000)) : 0;
    $('#msg').textContent = '已开始，正在执行' + (detail ? '：' + detail : '…')
      + (waited ? '（已过 ' + waited + ' 秒）' : '');
    $('#msg').style.color = 'var(--warn, #e0a94f)';
    $('#result').textContent = '';
    return;
  }
  sawRunning = false;
  if (failed || stopped) {
    $('#msg').textContent = failed ? '失败' : '已停止';
    $('#msg').style.color = 'var(--err)';
    $('#result').textContent = detail;
    return;
  }
  $('#msg').textContent = '已跑完';
  $('#msg').style.color = 'var(--ok)';
  $('#result').textContent = detail || '已跑完，没有文字结果';
}
async function poll() {
  const r = await api('/api/latest');
  if (!r || r.error) {
    if (lastJob) {
      $('#msg').textContent = '还没拿到这台电脑的状态：' + (r && r.error || '');
      $('#msg').style.color = 'var(--err)';
    }
    return;
  }
  if (!r.job) {
    if (sawRunning && r.bridgeOld) {
      sawRunning = false;
      $('#msg').textContent = '这台电脑上的任务已经不在执行。对方桥接是旧版，完成结果没有传回来。请把最新的 lan-bridge 技能拷过去，重新启动一次。';
      $('#msg').style.color = 'var(--err)';
    }
    return;
  }
  lastJob = r.job.id || lastJob;
  showJob(r.job);
}
$('#add').onclick = addPeer;
$('#go').onclick = runTask;
loadPeers(); loadMe(); poll();
setInterval(() => { loadPeers(); loadMe(); poll(); }, 3000);
</script></body></html>
"""


@app.get("/")
def index():
    return PAGE


@app.get("/api/peers")
def list_peers():
    with _lock:
        rows = [_public(v) for v in _peers.values()]
    rows.sort(key=lambda x: (not x["online"], x["name"]))
    return jsonify({"peers": rows})


@app.post("/api/peers")
def add_peer():
    data = request.get_json(silent=True) or {}
    item, err = _upsert((data.get("ip") or "").strip(), data.get("port") or 8799,
                        data.get("name") or "", True)
    if err:
        return jsonify({"ok": False, "error": err}), 400
    return jsonify({"ok": True, "peer": item})


@app.delete("/api/peers")
def delete_peer():
    data = request.get_json(silent=True) or {}
    ip = (data.get("ip") or "").strip()
    key = _key(ip, data.get("port") or 8799)
    with _lock:
        _peers.pop(key, None)
        _save(_peers)
    return jsonify({"ok": True})


@app.post("/api/register")
def register():
    data = request.get_json(silent=True) or {}
    item, err = _upsert((data.get("ip") or "").strip(), data.get("port") or 8799,
                        data.get("name") or "", False)
    if err:
        return jsonify({"ok": False, "error": err}), 400
    return jsonify({"ok": True, "peer": item})


def _client_ip():
    ip = (request.remote_addr or "").strip()
    if ip.startswith("::ffff:"):
        ip = ip[7:]
    if ip in ("127.0.0.1", "::1", "localhost"):
        ip = _lan_ip() or ip
    return ip


def _peer_for(ip):
    with _lock:
        matches = [v for v in _peers.values() if v.get("ip") == ip]
    if not matches:
        return None
    matches.sort(key=lambda v: (int(v.get("port") or 8799) != 8799,))
    return matches[0]


def _user_tasks(gateways):
    out = []
    for item in gateways or []:
        cwd = (item.get("cwd") or "").replace("/", "\\").lower()
        if "workbuddy-host-cli" in cwd or "__workbuddy_cli_host__" in cwd:
            continue
        out.append(item)
    return out


def _bridge_old(gateways):
    rows = list(gateways or [])
    return bool(rows) and all("startedAt" not in item for item in rows)


def _first_started(gateways):
    gateways = _user_tasks(gateways)
    if not gateways:
        return None

    def sort_key(item):
        started = item.get("startedAt") or 0
        return (0, started) if started else (1, 0)

    return sorted(gateways, key=sort_key)[0]


@app.get("/api/me")
def me():
    ip = _client_ip()
    peer = _peer_for(ip)
    if not peer:
        return jsonify({"ip": ip, "error": "这台电脑还没启动桥接"})
    code, body = _bridge_call(peer["ip"], peer.get("port") or 8799, "/api/gateways")
    gws = body.get("gateways") if isinstance(body, dict) else None
    task = _first_started(gws or [])
    if code != 200 or not task:
        err = body.get("error") if isinstance(body, dict) else None
        return jsonify({"ip": ip, "error": err or "这台电脑没有正在运行的 WorkBuddy 任务"})
    return jsonify({
        "ip": ip,
        "port": int(peer.get("port") or 8799),
        "name": peer.get("name") or ip,
        "bridgeOld": _bridge_old(gws),
        "task": {"url": task.get("url"), "title": task.get("title") or task.get("cwd") or ""},
    })


@app.get("/api/gateways")
def gateways():
    ip = (request.args.get("ip") or "").strip()
    code, body = _bridge_call(ip, request.args.get("port"), "/api/gateways")
    if code != 200:
        return jsonify({"gateways": [], "error": body.get("error") or body}), code if code >= 400 else 502
    return jsonify({"gateways": body.get("gateways") or [], "ip": ip})


@app.post("/api/dispatch")
def dispatch():
    data = request.get_json(silent=True) or {}
    ip = (data.get("ip") or "").strip() or _client_ip()
    peer = _peer_for(ip)
    if not peer:
        return jsonify({"ok": False, "error": "这台电脑（%s）还没启动桥接" % ip})
    port = data.get("port") or peer.get("port") or 8799
    gateway = data.get("gateway") or ""
    task_title = ""
    if not gateway:
        code, body = _bridge_call(ip, port, "/api/gateways")
        gws = body.get("gateways") if isinstance(body, dict) else None
        task = _first_started(gws or [])
        if code != 200 or not task:
            err = body.get("error") if isinstance(body, dict) else "没有可用任务"
            return jsonify({"ok": False, "error": err or "这台电脑没有正在运行的 WorkBuddy"})
        gateway = task.get("url") or ""
        task_title = task.get("title") or task.get("cwd") or ""
    code, body = _bridge_call(ip, port, "/api/dispatch", method="POST",
                              body={"gateway": gateway, "prompt": data.get("prompt") or "",
                                    "name": data.get("name") or "局域网通讯"},
                              timeout=60)
    if isinstance(body, dict) and body.get("ok"):
        body["ip"] = ip
        body["port"] = int(port)
        body["gateway"] = gateway
        body["taskTitle"] = task_title
        return jsonify(body)
    err = body.get("error") if isinstance(body, dict) else body
    if isinstance(err, (dict, list)):
        try:
            err = json.dumps(err, ensure_ascii=False)
        except Exception:
            err = str(err)
    return jsonify({"ok": False, "error": err, "status": code})


def _newest_job(jobs):
    if not jobs:
        return None
    return max(jobs, key=lambda item: item.get("updatedAt") or item.get("startedAt") or 0)


@app.get("/api/latest")
def latest():
    """当前这台电脑、最早那条任务上，最近一条派发的状态。"""
    ip = _client_ip()
    peer = _peer_for(ip)
    if not peer:
        return jsonify({"ip": ip, "error": "这台电脑还没启动桥接"})
    port = peer.get("port") or 8799
    code, body = _bridge_call(ip, port, "/api/gateways")
    gws = body.get("gateways") if isinstance(body, dict) else None
    task = _first_started(gws)
    if code != 200 or not task:
        err = body.get("error") if isinstance(body, dict) else None
        return jsonify({"ip": ip, "error": err or "这台电脑没有正在运行的 WorkBuddy 任务"})
    gateway = task.get("url") or ""
    path = "/api/jobs?" + urlencode({"gateway": gateway})
    code, body = _bridge_call(ip, port, path)
    jobs = body.get("jobs") if isinstance(body, dict) else None
    job = _newest_job(jobs or [])
    return jsonify({
        "ip": ip,
        "port": int(port),
        "gateway": gateway,
        "taskTitle": task.get("title") or task.get("cwd") or "",
        "bridgeOld": _bridge_old(gws),
        "job": job,
    })


@app.get("/api/transcript")
def transcript():
    """代取某台主机上某个任务的完整回答（桥接 /api/transcript）。"""
    ip = (request.args.get("ip") or "").strip()
    job_id = (request.args.get("id") or "").strip()
    if not job_id:
        return jsonify({"ok": False, "error": "缺少任务 id"})
    path = "/api/transcript?" + urlencode({"id": job_id})
    code, body = _bridge_call(ip, request.args.get("port"), path, timeout=45)
    if code != 200 or not isinstance(body, dict):
        err = body.get("error") if isinstance(body, dict) else body
        return jsonify({"ok": False, "error": err or "取全文失败"}), (code if code >= 400 else 502)
    body["ip"] = ip
    return jsonify(body)


@app.get("/api/jobs")
def jobs():
    ip = (request.args.get("ip") or "").strip()
    gateway = request.args.get("gateway") or ""
    path = "/api/jobs"
    if gateway:
        path += "?" + urlencode({"gateway": gateway})
    code, body = _bridge_call(ip, request.args.get("port"), path)
    if code != 200 or not isinstance(body, dict):
        return jsonify({"jobs": [], "error": body.get("error") if isinstance(body, dict) else body})
    return jsonify({"jobs": body.get("jobs") or [], "ip": ip})


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=5000)
    args = ap.parse_args()
    print("局域网通讯  http://127.0.0.1:%d/" % args.port, flush=True)
    print("每台电脑：python test1.py --lan --hub http://<本机局域网IP>:%d" % args.port, flush=True)
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
