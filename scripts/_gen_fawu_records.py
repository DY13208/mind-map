# -*- coding: utf-8 -*-
"""把 C:\\Users\\yr\\Desktop\\法务 下各公司的资质档案整理成图谱记录（含本地路径）。

数据来源：
  1) data/fawu/文件路径索引.csv —— 由 scripts/fawu-file-index.py 生成，提供每个文件的绝对路径
  2) data/fawu/_sources/*.txt   —— 由 wiki-contract-intake.py 抽出的正文（有文字的 PDF）
  3) data/fawu/_inbox/manifest.json —— 每份文件的状态（ok / needs-ocr / no-text）

输出：data/contracts/主体资质-<公司>.json（category = 集团主体资质）
"""
import csv
import json
import os
import re
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAWU = os.path.join(ROOT, "data", "fawu")
OUT = os.path.join(ROOT, "data", "contracts")
SRC_ROOT = r"C:\Users\yr\Desktop\法务"

F = ["主体名称", "注册信息", "资质文件", "本地路径", "备注"]

# 文件分类（按文件名）
PAT = [
    ("营业执照/注册证书", r"营业执照|執照|注册证书|註冊證書|公司注册|Certificate of Incorporation|사업자등록|법인|등기|\bCR\b"),
    ("商业登记证BR", r"\bBR\b|商业登记|商業登記|Business Registration"),
    ("周年申报NAR1/NR1", r"NAR1|NR1|周年申报|Annual Return"),
    ("经营许可/备案", r"食品经营许可证|经营许可证|许可|허가|备案回执|进出口收发货人|出口登记|备案"),
    ("商标", r"商标|商標|상표|trademark|logo"),
    ("税务/财税", r"税|稅|세무|tax|纳税|FATCA|CRS|增值税"),
    ("银行/账户", r"银行|銀行|开户|帳戶|账户|印鉴|流水|对账|對賬"),
    ("租赁/住所", r"租赁|租賃|住所|托管|辦公|办公|场地|房屋"),
    ("章程/公司治理", r"章程|Articles|组织大纲|董事|決議|决议|股东|股東|秘书|秘書"),
    ("身份证明", r"身份证|身份證|护照|護照|法人|신분"),
    ("合同/协议", r"合同|协议|協議|contract|Agreement|合约"),
    ("注销/变更", r"注销|註銷|变更|變更|撤销|遷|迁"),
]

# 关键文件优先展示（命中越靠前越重要）
KEY_ORDER = ["营业执照/注册证书", "商业登记证BR", "经营许可/备案", "周年申报NAR1/NR1",
             "商标", "税务/财税", "银行/账户", "章程/公司治理", "租赁/住所", "注销/变更"]


def classify(name):
    for label, pat in PAT:
        if re.search(pat, name, re.I):
            return label
    return "其他资料"


def load_index():
    p = os.path.join(FAWU, "文件路径索引.csv")
    with open(p, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def load_texts():
    """src_rel -> 正文（用于提取注册信息）"""
    man = os.path.join(FAWU, "_inbox", "manifest.json")
    out = {}
    if not os.path.exists(man):
        return out
    data = json.load(open(man, encoding="utf-8"))
    for it in data["items"]:
        t = it.get("txt")
        if it.get("status") in ("ok", "crude") and t and os.path.exists(t):
            try:
                out[it["path"]] = open(t, encoding="utf-8", errors="ignore").read()
            except OSError:
                pass
    return out


OCR_DIRS = [
    (r"D:\cathch\2026-09-28-20-05-32\tmp\ocr-fawu-out", "ocr-picked.json"),
    (r"D:\cathch\2026-09-28-20-05-32\tmp\ocr-fawu2-out", "ocr-picked2.json"),
]


def load_ocr():
    """公司分组 -> 该组证照扫描件的 OCR 文本列表"""
    res = defaultdict(list)
    for out_dir, picked_name in OCR_DIRS:
        p = os.path.join(FAWU, "_inbox", picked_name)
        if not (os.path.exists(p) and os.path.isdir(out_dir)):
            continue
        for it in json.load(open(p, encoding="utf-8")):
            base = os.path.splitext(os.path.basename(it["image"]))[0]
            f = os.path.join(out_dir, base + ".txt")
            if os.path.exists(f):
                res[it["group"]].append(open(f, encoding="utf-8", errors="ignore").read())
    return res


def dig_facts(joined):
    """从正文/OCR 里抠注册信息（有限枚举，抠不到就留空）"""
    joined = joined[:400000]
    facts = []

    def grab(label, pats, limit=6):
        seen = []
        for pat in pats:
            for m in re.finditer(pat, joined):
                v = m.group(1).strip().strip("：: ")
                # 过滤 OCR/正文噪声
                if not v or len(v) < 2:
                    continue
                if re.search(r"办税服务厅|变更发行|，需到|税务部门|防伪税控", v):
                    continue
                if re.fullmatch(r"(Private|Public|Company|Limited|Global Advisory|Advisory)( Limited)?", v):
                    continue
                if label == "统一社会信用代码/注册号" and not re.search(r"\d{6,}", v):
                    continue
                if label == "注册地址" and len(v) < 8:
                    continue
                if v not in seen:
                    seen.append(v)
                if len(seen) >= limit:
                    break
            if len(seen) >= limit:
                break
        if seen:
            facts.append("%s：%s" % (label, "；".join(seen)))

    grab("统一社会信用代码/注册号", [r"统一社会信用代码[\s:：]*([0-9A-Z]{15,20})",
                          r"注册号[\s:：]*([0-9A-Z\-]{6,25})",
                          r"公司編號[\s:：]*([0-9A-Z\-]{5,20})",
                          r"公司编号[\s:：]*([0-9A-Z\-]{5,20})",
                          r"Company No\.?[\s:：]*([0-9A-Z\-]{5,20})",
                          r"등록번호[\s:：]*([0-9\-]{8,15})"], limit=4)
    grab("英文名/商号", [r"(Still[A-Za-z ]{2,28}Limited)",
                   r"([A-Z][A-Za-z]+ (?:Digital )?[A-Za-z]+ (?:Research )?Limited)"], limit=3)
    grab("法定代表人", [r"法定代表人[\s:：]*([\u4e00-\u9fff]{2,4})"], limit=3)
    grab("成立日期", [r"成立日期[\s:：]*([0-9]{4}[-年.][0-9]{1,2}[-月.][0-9]{1,2})",
                  r"成立日期([0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日)",
                  r"Date of Incorporation[\s:：]*([0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2})"], limit=3)
    grab("注册资本", [r"注册资本[\s:：]*([0-9,，.]+)\s*万?元?", r"注册资金[\s:：]*([0-9,，.]+)\s*万?元?"], limit=3)
    grab("注册地址", [r"住\s*所[\s:：]*([\u4e00-\u9fff0-9A-Za-z（）()、，,\-号路街室层栋座]{8,60})",
                  r"注册地址[\s:：]*([\u4e00-\u9fff0-9A-Za-z（）()、，,\-号路街室层栋座]{8,60})"], limit=3)
    return facts


def main():
    rows = load_index()
    texts = load_texts()
    ocr = load_ocr()
    by_group = defaultdict(list)
    for r in rows:
        by_group[r["公司"]].append(r)
    # 公司 -> 该公司的全部正文（按路径前缀匹配）
    texts_by_group = defaultdict(list)
    for path, t in texts.items():
        for g in by_group:
            if path.startswith(os.path.join(SRC_ROOT, g)):
                texts_by_group[g].append(t)
                break

    # 形如 xxx(1) 的目录视为重复副本：不单独出记录，把路径记到主记录备注里
    dup_of = {}
    for g in list(by_group):
        base = re.sub(r"\(\d+\)$", "", g).strip()
        if base != g and base in by_group:
            dup_of.setdefault(base, []).append(g)

    written = 0
    for group, items in sorted(by_group.items()):
        if group in [d for ds in dup_of.values() for d in ds]:
            continue          # 重复目录跳过，稍后写进主记录备注
        disp = group.split("法务" + os.sep)[-1] if ("法务" + os.sep) in group else group
        disp = disp.replace("/", os.sep).strip()
        # 目录名去掉「(1) / -资质 / -资质与合同」等后缀，得到干净主体名
        disp = re.sub(r"\(\d+\)$", "", disp).strip()
        disp = re.sub(r"-\s*(资质与合同|资质)$", "", disp).strip()
        disp = re.sub(r"\s+香港$", "（香港）", disp)

        # 分类统计
        cnt = Counter(classify(i["文件名"]) for i in items)
        summary = "；".join("%s %d 件" % (k, v) for k, v in cnt.most_common())

        # 关键文件（带绝对路径）
        picked, used = [], set()
        for label in KEY_ORDER:
            for i in items:
                if i["本地绝对路径"] in used:
                    continue
                if classify(i["文件名"]) == label:
                    picked.append(i)
                    used.add(i["本地绝对路径"])
            if len(picked) >= 12:
                break
        # 不足 12 条再补其他
        if len(picked) < 12:
            for i in items:
                if i["本地绝对路径"] not in used:
                    picked.append(i)
                    used.add(i["本地绝对路径"])
                if len(picked) >= 12:
                    break

        files = []
        for i in picked:
            files.append("%s（%s）→ %s" % (i["文件名"][:60], i["类型"] or "-", i["本地绝对路径"]))
        if len(items) > len(picked):
            files.append("其余 %d 个文件同目录：%s" % (len(items) - len(picked), os.path.dirname(picked[0]["本地绝对路径"]) if picked else os.path.join(SRC_ROOT, group)))

        dir_path = os.path.join(SRC_ROOT, group)
        paths = ["目录：%s" % dir_path,
                 "完整清单（含每个文件的绝对路径）：%s" % os.path.join(FAWU, "文件路径索引.csv")]

        notes = []
        if group in dup_of:
            for d in dup_of[group]:
                notes.append("⚠️ 另有重复目录（内容基本一致，未逐份比对）：%s" % os.path.join(SRC_ROOT, d))
        if "注销" in summary:
            notes.append("含注销/变更类文件，主体可能已注销或发生过名称/地址变更")
        facts = dig_facts("\n".join(texts_by_group.get(group, []) + ocr.get(group, [])))
        ocr_n = len(ocr.get(group, []))
        if not facts:
            notes.append("⚠️ 该目录以扫描件为主，未抽取到注册信息（可走 OCR 通道补）")
        elif ocr_n:
            notes.append("注册信息含 %d 份扫描件的 OCR 结果，编号类字段建议与原照核对" % ocr_n)

        def first_or(items_list, default="-"):
            return items_list[0] if items_list else default

        rec = {
            "contract": "主体资质·%s" % disp,
            "category": "集团主体资质",
            "source_file": dir_path,
            "elements": {
                "主体名称": [disp, "文件 %d 件" % len(items)],
                "注册信息": facts if facts else ["⚠️ 未抽取到（扫描件为主）"],
                "资质文件": [summary] + files,
                "本地路径": paths,
                "备注": notes,
            },
        }
        name = re.sub(r'[\\/:*?"<>|]', "_", disp)
        with open(os.path.join(OUT, "主体资质-%s.json" % name), "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=2)
        written += 1

    print("写入 %d 条主体资质记录（共 %d 个分组、%d 个文件）" % (written, len(by_group), len(rows)))


if __name__ == "__main__":
    main()
