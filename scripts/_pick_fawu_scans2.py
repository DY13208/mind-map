# -*- coding: utf-8 -*-
"""第二轮：给还没抽到注册信息的公司，各挑 1-2 张扫描件首图做 OCR。"""
import csv
import json
import os
import re
import shutil
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAWU = os.path.join(ROOT, "data", "fawu")
GEN = os.path.join(ROOT, "data", "contracts")
STAGING = r"D:\cathch\2026-09-28-20-05-32\tmp\ocr-fawu2"
SEP = "\\"
SRC = r"C:\Users\yr\Desktop\法务"


def clean(s, n):
    return re.sub(r'[\\/:*?"<>|]', "_", s)[:n]


def main():
    man = json.load(open(os.path.join(FAWU, "_inbox", "manifest.json"), encoding="utf-8"))
    rows = list(csv.DictReader(open(os.path.join(FAWU, "文件路径索引.csv"), encoding="utf-8-sig")))
    grp_of = {r["本地绝对路径"]: r["公司"] for r in rows}

    # 已抽到注册信息的分组
    have = set()
    for f in os.listdir(GEN):
        if f.startswith("主体资质-") and f.endswith(".json"):
            d = json.load(open(os.path.join(GEN, f), encoding="utf-8"))
            info = d["elements"]["注册信息"]
            if info and not info[0].startswith("⚠️"):
                have.add(d["source_file"].replace(SRC + SEP, ""))

    by_group = defaultdict(list)
    for it in man["items"]:
        if it.get("status") != "needs-ocr" or not it.get("images"):
            continue
        g = grp_of.get(it["path"])
        if not g or g.replace("法务" + SEP, "", 1) in have:
            continue
        by_group[g].append((os.path.basename(it["rel"]), it["images"][0]))

    shutil.rmtree(STAGING, ignore_errors=True)
    os.makedirs(STAGING, exist_ok=True)
    picked = []
    for g in sorted(by_group):
        for base, img in by_group[g][:2]:
            if not os.path.exists(img):
                continue
            ext = os.path.splitext(img)[1] or ".jpg"
            dst = os.path.join(STAGING, "%s__%s%s" % (clean(g.split(SEP)[-1], 18), clean(os.path.splitext(base)[0], 40), ext))
            shutil.copy2(img, dst)
            picked.append({"group": g, "file": base, "image": dst})
    json.dump(picked, open(os.path.join(FAWU, "_inbox", "ocr-picked2.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("第二轮挑出 %d 张 → %s（覆盖 %d 个分组）" % (len(picked), STAGING, len(by_group)))


if __name__ == "__main__":
    main()
