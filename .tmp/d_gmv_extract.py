# -*- coding: utf-8 -*-
import json, os, re
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "d_gmv_subtree_rerun.json")
d = json.load(open(p, encoding="utf-8"))
items = d["items"]
print("nodes:", len(items), "version:", d["version"])
codes = {}
for it in items:
    t = (it.get("data", {}) or {}).get("text") or ""
    t = re.sub(r"<[^>]+>", "", t).strip()
    if not t:
        continue
    for c in re.findall(r"(13CHAN\d{5}(?:-\d+)?|XXJ\d+|SAIRAN\d+)", t):
        codes.setdefault(c, t)
print("== unique codes ==", len(codes))
for k in sorted(codes):
    print(k, "->", codes[k][:60])
print("== tiers present ==")
tiers = ["核心直营渠道","正常直营渠道","观察期直营渠道","核心分销渠道","正常分销渠道","渠道豁免","小红书","渠道增长"]
for ti in tiers:
    hit = [it for it in items if ti in re.sub(r"<[^>]+>","",(it.get("data",{}) or {}).get("text","") or "")]
    print(ti, "=>", len(hit))
