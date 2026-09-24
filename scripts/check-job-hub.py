#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通讯页（主服务）自检 —— 一条命令看清「页面到底该连哪个地址」。

页面点运行时走的链路是：

    页面（浏览器）→ 通讯页 /api/peers 拿主机列表 → 那台机器的桥接 8799 派任务

「连不上主服务」有三个完全不同的原因，这个脚本一次全测出来：

1. **地址猜错了**：页面在公网域名上时，前端会按 `<页面域名>:5000` 去猜，而那个端口
   往往是别的服务（实测 xx.stillgroup.net:5000 是群晖 NAS）；
2. **通讯页没在跑**：端口没人监听；
3. **跨源被浏览器拦了**：浏览器会先发 OPTIONS 预检、再要求响应带
   Access-Control-Allow-Origin，通讯页不吐这些头的话，服务在跑也"连不上"。

用法：
    python check-job-hub.py                      # 自动扫本机 :5000 / :5050
    python check-job-hub.py http://192.168.1.114:5050 ...
"""
import json
import os
import socket
import sys
import urllib.error
import urllib.request

TIMEOUT = 3.0
PORTS = (5000, 5050)


def _lan_ip():
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _call(url, method="GET", origin="", timeout=TIMEOUT):
    req = urllib.request.Request(url, method=method)
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
    return out


def verdict(row):
    if not row["status"]:
        return "连不上（端口没人监听 / 地址不对）"
    if not row["is_hub"]:
        return "这个端口是别的服务（不是通讯页）"
    if not row["acao"]:
        return "是通讯页，但没开跨源 —— 浏览器会拦掉"
    if row["options_status"] >= 400 or not row["options_acao"]:
        return "是通讯页，跨源预检（OPTIONS）没过"
    return "可用"


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
        targets.append("http://127.0.0.1:%d" % PORTS[0])

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

    good = [r for r in rows if verdict(r) == "可用"]
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
