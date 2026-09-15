#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wb_mcp

ROOM = "room-xgoibqb8"
UID = "2a6d0264-ab20-41bd-ae44-f70279be9ae1"

all_items = []
params = {"room_key": ROOM, "selector": {"type": "uid", "value": UID}, "scope": "subtree"}
cursor = None
pages = 0
while True:
    if cursor:
        params = {"room_key": ROOM, "selector": {"type": "uid", "value": UID}, "scope": "subtree", "cursor": cursor}
    d = wb_mcp.call("query_nodes", params)
    pages += 1
    items = d.get("items", [])
    all_items.extend(items)
    cursor = d.get("next_cursor")
    hm = d.get("has_more")
    print(f"page {pages}: items={len(items)} has_more={hm}")
    if not hm or not cursor:
        break
    if pages > 40:
        break

out = {"version": d.get("version"), "total": len(all_items), "items": all_items}
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "d_tmall_subtree_all.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("saved total", len(all_items))
