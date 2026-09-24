#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通讯页 / 任务桥 自检 —— 一条命令看清「页面到底该连哪个地址」以及「回传能力齐不齐」。

页面点「运行」走的链路是：

    页面（浏览器）→ 通讯页 /api/peers 拿主机列表 → 那台机器的桥接 8799 派任务
    任务跑完 → 前端再从桥接取「完整回答 + 产物」写回脑图

「连不上主服务」有三个完全不同的原因，这个脚本一次全测出来：

1. **地址猜错了**：页面在公网域名上时，前端会按 `<页面域名>:5000` 去猜，而那个端口
   往往是别的服务（实测 xx.stillgroup.net:5000 是群晖 NAS）；
2. **通讯页没在跑**：端口没人监听；
3. **跨源被浏览器拦了**：浏览器会先发 OPTIONS 预检、再要求响应带
   Access-Control-Allow-Origin，通讯页不吐这些头的话，服务在跑也"连不上"。

地址给的是**桥接**时，还会逐个探「回传要用到的接口」，一眼看出那台是不是旧版：

    /api/transcript     任务的完整回答（没它 → 跑完不回传文字）
    /api/job-artifacts  产物清单（没它 → 附件回传不了）
    /api/stop           停止任务
    /api/attach         经桥接挂附件

用法：
    python check-job-hub.py                             # 自动扫本机 :5000 / :5050 / :8799
    python check-job-hub.py http://192.168.1.114:8799   # 查某台机器的桥接（回传能力）
    python check-job-hub.py https://xx.stillgroup.net:8989/jobhub
"""
import json
import socket
import sys
import urllib.error
import urllib.request

TIMEOUT = 8.0
PORTS = (5000, 5050, 8799)
BRIDGE_PROBES = (
    ("GET", "/api/transcript?id=__probe__", "任务的完整回答（不回传文字就是缺它）"),
    ("GET", "/api/job-artifacts?id=__probe__", "产物清单（附件回传靠它）"),
    ("POST", "/api/stop", "停止任务"),
    ("POST", "/api/attach", "经桥接挂附件"),
)
# 公网页面走同源中继时，通讯页上也必须有这几个转发口（旧版只有 dispatch/jobs/transcript）
HUB_RELAY_PROBES = (
    ("GET", "/api/job-artifacts?ip=127.0.0.1&port=8799&id=__probe__", "中继 · 产物清单（附件回传）"),
    ("GET", "/api/transcript?ip=127.0.0.1&port=8799&id=__probe__", "中继 · 任务完整回答"),
    ("POST", "/api/stop", "中继 · 停止任务"),
    ("POST", "/api/attach", "中继 · 挂附件"),
)
JOBS_TIMEOUT = 12.0


def _lan_ip():
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _call(url, method="GET", origin="", timeout=TIMEOUT, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if origin:
        req.add_header("Origin", origin)
        req.add_header("Access-Control-Request-Method", "GET")
        req.add_header("Access-Control-Request-Headers", "content-type")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read(4000).decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read(1000).decode("utf-8", "replace")
    except Exception as err:
        return 0, {}, str(err)


def _headers_lower(headers):
    return {str(k).lower(): v for k, v in headers.items()}


def _route_missing(status, body):
    """接口不存在时桥接会回 404 {"error": "not found"}；通讯页则是 Flask 的 HTML 404"""
    if status != 404:
        return False
    return "not found" in (body or "").lower()


def _route_missing_flask(status, body):
    """通讯页（Flask）路由不存在时回的是 HTML 404；JSON 404 说明中继在、上游桥接缺接口"""
    if status != 404:
        return False
    return (body or "").lstrip().startswith("<")


def _relay_upstream_missing(status, body):
    return status == 404 and not (body or "").lstrip().startswith("<")


def check(base, origin):
    base = base.rstrip("/")
    out = {"base": base}
    status, headers, body = _call(base + "/api/peers", origin=origin)
    low = _headers_lower(headers)
    out["status"] = status
    try:
        data = json.loads(body)
    except Exception:
        data = None
    out["is_hub"] = bool(isinstance(data, dict) and isinstance(data.get("peers"), list))
    out["peers"] = (data or {}).get("peers") if out["is_hub"] else None
    out["acao"] = low.get("access-control-allow-origin", "")
    out["pna"] = low.get("access-control-allow-private-network", "")
    opt_status, opt_headers, _ = _call(base + "/api/peers", method="OPTIONS", origin=origin)
    opt_low = _headers_lower(opt_headers)
    out["options_status"] = opt_status
    out["options_acao"] = opt_low.get("access-control-allow-origin", "")

    # 不是通讯页的话，看看是不是任务桥（回传能力的检查）
    out["is_bridge"] = False
    out["bridge_probes"] = []
    out["bridge_jobs"] = None
    out["hub_probes"] = []
    if out["is_hub"]:
        for method, path, label in HUB_RELAY_PROBES:
            payload = {} if method == "POST" else None
            pst, _ph, pbd = _call(base + path, method=method, timeout=TIMEOUT, body=payload)
            out["hub_probes"].append({
                "path": path,
                "label": label,
                "status": pst,
                "missing": _route_missing_flask(pst, pbd),
                "upstream_missing": _relay_upstream_missing(pst, pbd),
                "body": (pbd or "")[:90],
            })
    if not out["is_hub"] and status:
        st, _h, bd = _call(base + "/api/gateways", timeout=TIMEOUT)
        try:
            g = json.loads(bd)
        except Exception:
            g = None
        if st == 200 and isinstance(g, dict) and isinstance(g.get("gateways"), list):
            out["is_bridge"] = True
            out["bridge_sessions"] = len(g.get("gateways") or [])
            for method, path, label in BRIDGE_PROBES:
                payload = {} if method == "POST" else None
                pst, _ph, pbd = _call(base + path, method=method, timeout=TIMEOUT, body=payload)
                out["bridge_probes"].append({
                    "path": path,
                    "label": label,
                    "status": pst,
                    "missing": _route_missing(pst, pbd),
                    "body": (pbd or "")[:90],
                })
            jst, _jh, jbd = _call(base + "/api/jobs?all=1", timeout=JOBS_TIMEOUT)
            try:
                out["bridge_jobs"] = len((json.loads(jbd) or {}).get("jobs") or [])
            except Exception:
                out["bridge_jobs"] = None
    return out


def verdict(row):
    if not row["status"]:
        return "连不上（端口没人监听 / 地址不对）"
    if row["is_bridge"]:
        missing = [p["label"] for p in row.get("bridge_probes") or [] if p["missing"]]
        if missing:
            return "是任务桥，但**是旧版**：缺 %d 个回传接口" % len(missing)
        return "任务桥可用（回传接口齐）"
    if row["is_hub"]:
        missing = [p["label"] for p in row.get("hub_probes") or [] if p["missing"]]
        ups = [p["label"] for p in row.get("hub_probes") or [] if p.get("upstream_missing")]
        if missing:
            return "是通讯页，但**中继口不全**：缺 %d 个（公网页面回传/停止会失败）" % len(missing)
        if ups:
            return "是通讯页，中继口在，但**上游桥接缺 %d 个接口**（要先升级那台桥接）" % len(ups)
        if not row["acao"]:
            return "是通讯页，但没开跨源 —— 浏览器会拦掉"
        if row["options_status"] >= 400 or not row["options_acao"]:
            return "是通讯页，跨源预检（OPTIONS）没过"
        return "可用"
    return "这个端口是别的服务（既不是通讯页也不是任务桥）"


def address_ok(row):
    """地址本身能不能当「主服务」用（中继口缺不全另算，下面的提醒里会说）"""
    if not row["status"]:
        return False
    if row.get("is_bridge"):
        return False   # 桥接是执行侧，不能当页面的「主服务」地址
    if row["is_hub"]:
        return bool(row["acao"]) and row["options_status"] < 400 and bool(row["options_acao"])
    return False


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    ip = _lan_ip()
    if args:
        targets = [a if a.startswith("http") else "http://" + a for a in args]
    else:
        targets = ["http://%s:%d" % (ip, p) for p in PORTS]
        targets.append("http://127.0.0.1:%d" % PORTS[1])

    origin = "http://%s:8989" % ip
    print("本机局域网 IP  %s" % ip)
    print("模拟页面来源  %s" % origin)
    print("=" * 74)

    rows = []
    for base in targets:
        row = check(base, origin)
        rows.append(row)
        status = row["status"] or "ERR"
        print("%-34s %-5s %s" % (row["base"], status, verdict(row)))
        if row["is_hub"]:
            peers = row["peers"] or []
            for peer in peers:
                mark = "在线" if peer.get("online") else "离线"
                print("      %-22s %-18s %s" % (peer.get("name") or "?", "%s:%s" % (peer.get("ip"), peer.get("port")), mark))
        if row.get("is_bridge"):
            print("      会话 %s 个 · 任务 %s 条" % (row.get("bridge_sessions"), row.get("bridge_jobs")))
            for probe in row["bridge_probes"]:
                flag = "缺 " if probe["missing"] else "有 "
                print("      [%s] %-24s %s" % (flag, probe["path"], probe["label"]))
        if row["is_hub"] and row.get("hub_probes"):
            for probe in row["hub_probes"]:
                if probe["missing"]:
                    flag = "缺 "
                elif probe.get("upstream_missing"):
                    flag = "上游缺"
                else:
                    flag = "有 "
                print("      [%s] %-24s %s" % (flag, probe["path"].split("?")[0], probe["label"]))

    good = [r for r in rows if address_ok(r)]
    bridges = [r for r in rows if r.get("is_bridge")]
    broken = [r for r in bridges if verdict(r).startswith("是任务桥，但")]
    hubs_broken = [r for r in rows if r.get("is_hub") and "中继口不全" in verdict(r)]
    print("=" * 74)
    if good:
        print("页面应该连：%s" % good[0]["base"])
        print("页面地址上带一次就记住了：?hub=%s" % good[0]["base"])
    else:
        print("没找到可用的通讯页。要做的：")
        print("  1) 在通讯页那台机器上启动它：")
        print("       python workbuddy-lan-hub.py --port 5000      # 或双击 start-lan-hub.bat")
        print("  2) 确认它跑在页面浏览器能访问到的网段（同一局域网）")
        print("  3) 页面在公网域名（https）上时，浏览器不允许直连局域网 http 地址：")
        print("     让运维在服务器加一条反代 location /jobhub/ -> 通讯页即可同源访问")
    if broken:
        print()
        print("这几台的桥接是旧版，跑完任务不会回传文字/产物：")
        for row in broken:
            print("  %s" % row["base"])
        print("  换成本仓库的 scripts/workbuddy-job-bridge.py（改名成你原来那个文件名），重启即可")
    if hubs_broken:
        print()
        print("这几个通讯页缺中继口（公网页面走同源 /jobhub 时回传、停止都会 404）：")
        for row in hubs_broken:
            print("  %s" % row["base"])
        print("  换成本仓库的 scripts/workbuddy-lan-hub.py 后重启通讯页")
    if bridges:
        empty = [r for r in bridges if r.get("bridge_jobs") == 0]
        if empty:
            print()
            print("提醒：以下桥接当前**查不到任何任务**（任务记录在执行主机的 WorkBuddy 内存里，")
            print("WorkBuddy 或桥接重启过就会清空）—— 这类情况下跑完的结果也不会回传：")
            for row in empty:
                print("  %s" % row["base"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
