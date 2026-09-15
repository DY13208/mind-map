#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wb_mcp

ROOM = "room-xgoibqb8"

def strip(t):
    if t is None: return ""
    return re.sub(r"<[^>]+>", "", str(t)).replace("&amp;", "&").strip()

def subtree_all(uid):
    items = []
    params = {"room_key": ROOM, "selector": {"type": "uid", "value": uid}, "scope": "subtree"}
    cursor = None
    while True:
        if cursor:
            params = {"room_key": ROOM, "selector": {"type": "uid", "value": uid}, "scope": "subtree", "cursor": cursor}
        d = wb_mcp.call("query_nodes", params)
        items.extend(d.get("items", []))
        cursor = d.get("next_cursor")
        if not d.get("has_more") or not cursor:
            break
    return items

targets = {
    "P：渠道目标": "9d1666b4",
    "P：渠道库存健康分": "ce1718dd",
    "D：天猫站内推广": "b8455bf3",
    "D：天猫定期报告": "03072230",
}

results = {}
for name, uid8 in targets.items():
    # resolve full uid by searching room
    sn = wb_mcp.call("search_nodes", {"room_key": ROOM, "query": name})
    full = None
    for it in (sn.get("items") or []):
        u = it.get("uid") or it.get("data", {}).get("uid")
        if u and u.startswith(uid8):
            full = u
            break
    if not full:
        # fall back: try to find via children of 周中昱 (already known uids)
        full = None
    results[name] = {"resolved": full}
    print("=" * 80)
    print(name, "->", full)
    if full:
        items = subtree_all(full)
        print("  nodes:", len(items))
        for it in items:
            dd = it.get("data", {})
            link = dd.get("hyperlink")
            note = dd.get("note")
            if link or note:
                print("   LINK:", strip(dd.get("text")), "=>", link or ("NOTE:" + strip(note)))
        # print shallow tree
        kids = {}
        for it in items:
            kids.setdefault(it.get("parent_uid"), []).append(it)
        def walk(u, dep):
            it = next((x for x in items if x["uid"] == u), None)
            if not it: return
            d = it.get("data", {})
            line = "    " + "  " * dep + "- " + strip(d.get("text"))
            if d.get("hyperlink"):
                line += "  [" + str(d["hyperlink"]) + "]"
            print(line)
            for c in kids.get(u, []):
                walk(c["uid"], dep + 1)
        if items:
            walk(items[0]["uid"], 0)
