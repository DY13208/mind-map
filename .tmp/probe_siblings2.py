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

ch = wb_mcp.call("query_nodes", {"room_key": ROOM, "selector": {"type": "uid", "value": "497636fd-5546-4466-81d5-7769486b0fe4"}, "scope": "children"})
kids = []
for it in ch.get("items", []):
    d = it.get("data", {})
    kids.append((it["uid"], strip(d.get("text")), d.get("hyperlink")))
print("周中昱 children:")
for u, t, l in kids:
    print("  ", u, t, l)

for uid, name, _ in kids:
    if name == "D：天猫运营":
        continue
    items = subtree_all(uid)
    print("=" * 90)
    print(name, uid, "nodes:", len(items))
    for it in items:
        d = it.get("data", {})
        if d.get("hyperlink") or d.get("note"):
            print("  LINK/NOTE:", strip(d.get("text")), "=>", d.get("hyperlink") or ("NOTE:" + strip(d.get("note"))))
    # shallow tree
    km = {}
    for it in items:
        km.setdefault(it.get("parent_uid"), []).append(it)
    def walk(u, dep):
        it = next((x for x in items if x["uid"] == u), None)
        if not it: return
        d = it.get("data", {})
        line = "    " + "  " * dep + "- " + strip(d.get("text"))
        if d.get("hyperlink"):
            line += "  [L]"
        print(line)
        for c in km.get(u, []):
            walk(c["uid"], dep + 1)
    if items:
        walk(items[0]["uid"], 0)
