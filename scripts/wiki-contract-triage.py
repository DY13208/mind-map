#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
合同入库 · 第二步（分流）：把 _sources 里的正文分成「可直接提取 / 空模板 / 重复版本 / 需视觉读图」。

第一步 wiki-contract-intake.py 只按文件名筛候选，实际正文里混着三类不该提取的东西：
  · 空模板：甲乙双方、金额、期限全是【 】/____，只是范本
  · 重复版本：(1)(2)/副本/V1/不同日期，其实是同一份
  · 扫描件：无文字层，只能读页图

用法：
  python scripts/wiki-contract-triage.py --month 2026-01
  python scripts/wiki-contract-triage.py --all
  python scripts/wiki-contract-triage.py --all --json > /tmp/triage.json
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN = os.path.join(ROOT, "data", "contracts")
MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05",
          "2026-06", "2026-07", "2026-08", "2026-09"]

# 空模板特征
BLANK = re.compile(r"【\s*/?\s*】|_{4,}|＿{4,}|\(\s*\)\s*元|人民币\s*【\s*】")
COMPANY = re.compile(r"(有限公司|股份公司|株式会社|集团|Co\.,?\s*Ltd|Limited|Ltd\.|Inc\.|LLC|个体工商户)")
# 版本后缀（同名 → 同一份的不同版本）
VERSION_SUFFIX = re.compile(r"(副本|copy|\(\d+\)|（\d+）|\[\d+\]|v\d+|final|最终版|clean|修改版|最新|定稿|修订版|정정|추가|검토|\bfinal\b)", re.I)
DATE_SUFFIX = re.compile(r"(still\s*\d{3,4}|\d{6,8}|20\d{2}[-._]\d{1,2}[-._]\d{1,2}|\d{4}年\d{1,2}月)", re.I)


def normalize_stem(rel):
    s = os.path.splitext(os.path.basename(rel))[0].lower()
    s = re.sub(r"[\s_\-（）()【】\[\]．.]+", "", s)
    prev = None
    while prev != s:
        prev = s
        s = VERSION_SUFFIX.sub("", s)
        s = DATE_SUFFIX.sub("", s)
    return s


def read_manifest(month):
    p = os.path.join(MAIN, month, "_inbox", "manifest.json") if month != "2026-02" \
        else os.path.join(MAIN, "_inbox", "manifest.json")
    if not os.path.exists(p):
        return None
    return json.load(open(p, encoding="utf-8"))


def classify(item):
    st = item.get("status")
    if st == "needs-ocr":
        return "needs-ocr", "扫描件无文字层，读页图"
    if st == "no-text":
        return "no-text", "无文字层且导不出图，需人工/OCR"
    if st not in ("ok", "crude"):
        return "unusable", "抽取失败或过短"
    txt = item.get("txt") or ""
    if not os.path.exists(txt):
        return "unusable", "正文文件缺失"
    t = open(txt, encoding="utf-8", errors="ignore").read()
    body = t[:60000]
    if st == "crude" and len(body.strip()) < 400:
        return "unusable", "老 doc 抽出的可用正文过短"
    blanks = len(BLANK.findall(body))
    companies = len(set(COMPANY.findall(body)))
    per_k = blanks * 1000.0 / max(1, len(body))
    if blanks >= 6 and companies <= 1 and per_k >= 1.5:
        return "blank-template", "空模板（填空位 %d 处、主体名 %d 个）" % (blanks, companies)
    return "ready", "正文可用"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    months = MONTHS if (args.all or not args.month) else [args.month]
    report = {}
    grand = defaultdict(int)
    for m in months:
        man = read_manifest(m)
        if not man:
            print("! %s 无清单，先跑 wiki-contract-intake.py" % m)
            continue
        # 已在 wiki（主目录 data/contracts/*.json 的 source_file）
        taken = set()
        for f in os.listdir(MAIN):
            if f.endswith(".json"):
                try:
                    sp = json.load(open(os.path.join(MAIN, f), encoding="utf-8"))
                    if sp.get("source_file"):
                        taken.add(os.path.basename(sp["source_file"]))
                except Exception:
                    pass
        buckets = defaultdict(list)
        seen_stem = {}
        for it in man["items"]:
            base = os.path.basename(it["rel"])
            if base in taken:
                buckets["already"].append(it["rel"])
                continue
            cat, why = classify(it)
            if cat == "ready":
                stem = normalize_stem(it["rel"])
                if stem in seen_stem:
                    buckets["dup-version"].append(it["rel"])
                    continue
                seen_stem[stem] = it["rel"]
            buckets[cat].append(it["rel"])
            it["_why"] = why
        report[m] = {k: len(v) for k, v in sorted(buckets.items())}
        report[m]["ready_files"] = buckets["ready"]
        for k, v in buckets.items():
            grand[k] += len(v)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    keys = ["ready", "blank-template", "dup-version", "needs-ocr", "no-text", "already", "unusable"]
    head = "%-9s" % "月份" + "".join("%12s" % k for k in keys)
    print(head)
    for m in months:
        if m not in report:
            continue
        print("%-9s" % m + "".join("%12d" % report[m].get(k, 0) for k in keys))
    print("%-9s" % "合计" + "".join("%12d" % grand.get(k, 0) for k in keys))
    print()
    print("可直接提取（ready，去重去空模板后）：%d 份" % grand.get("ready", 0))


if __name__ == "__main__":
    main()
