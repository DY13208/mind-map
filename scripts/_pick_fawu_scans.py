# -*- coding: utf-8 -*-
"""挑出各公司证照类扫描件（首图）到暂存目录，供 OCR 使用。"""
import csv
import json
import os
import re
import shutil
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAWU = os.path.join(ROOT, "data", "fawu")
STAGING = r"D:\cathch\2026-09-28-20-05-32\tmp\ocr-fawu"
SEP = "\\"

KEY = re.compile(
    r"营业执照|執照|注册证书|註冊證書|Certificate of Incorporation|\bCR\b|"
    r"商业登记|商業登記|\bBR\b|NAR1|周年申报|食品经营许可证|经营许可证|备案回执|"
    r"등기|사업자등록|법인", re.I)


def clean(s, n):
    return re.sub(r'[\\/:*?"<>|]', "_", s)[:n]


def main():
    man = json.load(open(os.path.join(FAWU, "_inbox", "manifest.json"), encoding="utf-8"))
    rows = list(csv.DictReader(open(os.path.join(FAWU, "文件路径索引.csv"), encoding="utf-8-sig")))
    grp_of = {r["本地绝对路径"]: r["公司"] for r in rows}

    shutil.rmtree(STAGING, ignore_errors=True)
    os.makedirs(STAGING, exist_ok=True)

    by_group = defaultdict(list)
    for it in man["items"]:
        if it.get("status") != "needs-ocr" or not it.get("images"):
            continue
        base = os.path.basename(it["rel"])
        if not KEY.search(base):
            continue
        g = grp_of.get(it["path"], "?")
        by_group[g].append((base, it["images"][0]))

    picked = []
    for g in sorted(by_group):
        for base, img in by_group[g][:2]:
            if not os.path.exists(img):
                continue
            ext = os.path.splitext(img)[1] or ".jpg"
            short = g.split(SEP)[-1]
            dst = os.path.join(STAGING, "%s__%s%s" % (clean(short, 18), clean(os.path.splitext(base)[0], 40), ext))
            shutil.copy2(img, dst)
            picked.append({"group": g, "file": base, "image": dst})

    with open(os.path.join(FAWU, "_inbox", "ocr-picked.json"), "w", encoding="utf-8") as f:
        json.dump(picked, f, ensure_ascii=False, indent=1)

    print("挑出扫描件 %d 张 → %s" % (len(picked), STAGING))
    for p in picked[:14]:
        print("  %-24s | %s" % (p["group"].split(SEP)[-1][:24], p["file"][:44]))


if __name__ == "__main__":
    main()
