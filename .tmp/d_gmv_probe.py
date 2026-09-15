# -*- coding: utf-8 -*-
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wb_mcp

ROOM = "room-xgoibqb8"
UID = "a591bb32-4095-4a6d-aa41-277853a89a1f"

# 1) locate the node itself
r = wb_mcp.call("query_nodes", {"room_key": ROOM, "selector": {"type": "uid", "value": UID}, "scope": "self"})
print("== SELF ==")
print(json.dumps(r, ensure_ascii=False)[:1500])

# 2) subtree, paging
items = []
params = {"room_key": ROOM, "selector": {"type": "uid", "value": UID}, "scope": "subtree"}
page = wb_mcp.call("query_nodes", params)
if not isinstance(page, dict):
    print("== SUBTREE NON-DICT type ==", type(page))
    print(repr(page)[:2000])
    sys.exit(0)
ver = None
while True:
    ver = page.get("version") if isinstance(page, dict) else None
    for it in page.get("items", []):
        items.append(it)
    if isinstance(page, dict) and page.get("has_more") and page.get("next_cursor"):
        params2 = dict(params); params2["cursor"] = page["next_cursor"]
        page = wb_mcp.call("query_nodes", params2)
        if not isinstance(page, dict):
            print("== PAGE2 NON-DICT ==", type(page)); print(repr(page)[:800]); break
    else:
        break

print("== SUBTREE count ==", len(items), "version", ver)
out = {"version": ver, "count": len(items), "items": items}
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "d_gmv_subtree_rerun.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

# collect hyperlinks / notes / numeric-looking text
links = []
for it in items:
    d = it.get("data", {}) or {}
    t = (d.get("text") or "")
    hl = d.get("hyperlink")
    note = d.get("note")
    gen = d.get("generalization")
    if hl:
        links.append({"depth": it.get("relative_depth"), "text": t[:80], "hyperlink": hl})
    if note:
        links.append({"depth": it.get("relative_depth"), "text": t[:40], "note": str(note)[:200]})
    if gen:
        links.append({"depth": it.get("relative_depth"), "text": t[:40], "generalization": str(gen)[:300]})
print("== LINKS/NOTES/GEN ==")
print(json.dumps(links, ensure_ascii=False, indent=1))
