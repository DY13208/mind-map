#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, re, os
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "d_tmall_subtree_all.json")
d = json.load(open(p, encoding="utf-8"))
items = d["items"]
by_uid = {it["uid"]: it for it in items}
root_uid = items[0]["uid"]

def strip(t):
    if t is None:
        return ""
    t = re.sub(r"<[^>]+>", "", str(t))
    return t.replace("&amp;", "&").strip()

children = {}
for it in items:
    children.setdefault(it.get("parent_uid"), []).append(it)

print("version:", d.get("version"), "total:", d.get("total"))
print("=" * 100)

def walk(uid, depth):
    it = by_uid.get(uid)
    if not it:
        return
    data = it.get("data", {})
    text = strip(data.get("text"))
    extras = []
    if data.get("hyperlink"):
        extras.append("LINK=" + str(data["hyperlink"]))
    if data.get("note"):
        extras.append("NOTE=" + strip(data["note"]))
    for k, v in data.items():
        if k.startswith("field:") and k not in ("field:hasMore", "field:traceId", "field:subtreeVersion", "field:mark", "field:icon"):
            extras.append(f"{k}={strip(v)}")
    if data.get("generalization"):
        try:
            g = json.dumps(data["generalization"], ensure_ascii=False)
        except Exception:
            g = str(data["generalization"])
        extras.append("GEN=" + g[:300])
    tid = data.get("traceId")
    if tid:
        extras.append("trace=" + str(tid))
    line = "  " * depth + f"- [{it['uid'][:8]}] {text}"
    if extras:
        line += "   || " + " | ".join(extras)
    print(line)
    for c in children.get(uid, []):
        walk(c["uid"], depth + 1)

walk(root_uid, 0)
