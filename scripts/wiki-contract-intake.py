#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
合同归档批量入库 · 第一步：扫描 + 抽正文 + 生成待提取清单。

不做语义判断（不猜哪份是哪类合同、要素是什么），只把机器能确定的事做完：
  1) 递归扫描指定目录，按扩展名 + 文件名关键词筛出「疑似合同」
  2) 抽出纯文本（docx 含表格；pdf 用 pypdf；doc 走二进制粗抽）
  3) 去重（同一份合同的 docx/pdf 双份、同名副本）与已入库去重
  4) 落盘到 <out>/_sources/<slug>.txt，并写 <out>/_inbox/manifest.json

用法：
  python scripts/wiki-contract-intake.py --dir "E:\\2026-02\\2026-02"
  python scripts/wiki-contract-intake.py --dir "E:\\2026-02" --recursive --all
  python scripts/wiki-contract-intake.py --dir <dir> --dry-run

参数：
  --dir        必填，扫描根目录
  --out        输出根（默认 data/contracts）
  --all        不做文件名筛词，所有 doc/docx/pdf 都当候选（默认按关键词筛）
  --limit N    只处理前 N 个候选（便于先试跑）
  --refresh    忽略缓存，强制重新抽文本
  --dry-run    只列清单，不写文件

依赖：python-docx / pypdf（本机 miniconda 的 python 已具备）
"""
import argparse
import hashlib
import json
import os
import re
import sys
import datetime

try:
    import docx  # python-docx
except Exception:
    docx = None
try:
    from pypdf import PdfReader
except Exception:
    try:
        from PyPDF2 import PdfReader
    except Exception:
        PdfReader = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 文件名命中这些词 → 疑似合同
KW = re.compile(r"合同|协议|契约|agreement|contract|계약|供应|供货|采购|合作|订购|订单|确认书|授权|委托|备忘录|保密|NDA|约定", re.I)
# 命中这些词 → 明显不是合同（证照/票据/报告/图片类）
NEG = re.compile(r"发票|税单|invoice|영수증|营业执照|사업자등록|COA|质检|检验|检测报告|MSDS|装箱|提单|报关|BOM|报价单|图片|截图|logo|样品|价目表|收据", re.I)
# Word 临时/锁文件
TEMP = re.compile(r"^~\$|\$[^\\/]*\.(docx?|xlsx?)$", re.I)
# 附件类（授权书/委托书/声明书等，随合同走但不是合同本体，默认跳过）
ATTACH = re.compile(r"授权书|授权声明|委托书|声明书|power of attorney|\bPOA\b|店铺信息使用授权|使用授权", re.I)

EXTS = {".docx", ".doc", ".pdf"}


def log(*a):
    print(*a, flush=True)


def sanitize(name, maxlen=80):
    s = re.sub(r"[\\/:*?\"<>|\r\n\t]+", "_", name).strip(" ._")
    s = re.sub(r"\s+", "_", s)
    return s[:maxlen] or "unnamed"


def sha1_file(path, chunk=1 << 20):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def extract_docx(path):
    """段落 + 表格，按出现顺序拼接（合同要素常在表格里）。"""
    if docx is None:
        raise RuntimeError("python-docx 不可用")
    d = docx.Document(path)
    out = []
    for p in d.paragraphs:
        t = (p.text or "").strip()
        if t:
            out.append(t)
    for ti, tb in enumerate(d.tables):
        out.append("【表格%d】" % (ti + 1))
        for row in tb.rows:
            cells = []
            for c in row.cells:
                cells.append((c.text or "").replace("\n", " ").strip())
            # 去掉相邻重复单元格（合并单元格会重复文本）
            dedup = []
            for c in cells:
                if not dedup or dedup[-1] != c:
                    dedup.append(c)
            line = " | ".join(x for x in dedup if x)
            if line:
                out.append(line)
    return "\n".join(out)


def extract_pdf(path):
    """pypdf 优先，失败/空则退回 pdfminer.six（部分文件 pypdf 会报 Boolean object 之类错）。"""
    text, err = "", None
    if PdfReader is not None:
        try:
            r = PdfReader(path)
            out = []
            for i, page in enumerate(r.pages):
                try:
                    t = page.extract_text() or ""
                except Exception as e:
                    t = ""
                    log("    ! 第%d页抽取失败: %s" % (i + 1, e))
                t = t.strip()
                if t:
                    out.append("【第%d页】" % (i + 1))
                    out.append(t)
            text = "\n".join(out)
        except Exception as e:
            err = str(e)[:80]
    if len(text.strip()) < 100:
        alt = _extract_pdf_miner(path)
        if len(alt.strip()) > len(text.strip()):
            text, err = alt, None
    if not text.strip() and err:
        raise RuntimeError(err)
    return text


def _extract_pdf_miner(path):
    try:
        from pdfminer.high_level import extract_text as miner_text
    except Exception:
        return ""
    try:
        return miner_text(path)
    except Exception as e:
        log("    ! pdfminer 也失败: %s" % str(e)[:80])
        return ""


CJK = re.compile(r"[\u4e00-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]")
# 真实文本才会有的常用虚词与标点（用于剔除二进制解出来的「随机汉字」噪声段）
SANE = re.compile(r"[的是在有不与及为以对应当甲乙双方条款年月日本合同协议约定支付；：，。、（）%]")


NOISE = re.compile(
    r"^(SummaryInformation|DocumentSummaryInformation|WordDocument|Normal\.dotm|"
    r"KSOProductBuildVer|KSOTemplateDoc|WPS Office|Microsoft|Root Entry|Data|1Table|0Table|"
    r"CompObj|ObjectPool|WordDocument$)", re.I)


def extract_doc_binary(path):
    """老 .doc（OLE）无库可用的降级方案：按编码粗扫可读文本片段。

    两个坑：
      1) OLE 里同一段文本会有多个副本 → 必须去重（实测不去重会把正文放大 10 倍以上）
      2) 二进制解出来的「随机汉字」段不是文本 → 用常用虚词/标点的密度筛掉
         实测：密度 ≥0.10 时能从 822k 噪声里提出 1.7 万字真实正文
    """
    raw = open(path, "rb").read()
    best, best_score = [], -1
    for enc in ("utf-16-le", "gb18030", "cp949"):
        try:
            s = raw.decode(enc, "ignore")
        except Exception:
            continue
        rows = []
        for c in re.findall(r"[^\x00-\x08\x0b\x0c\x0e-\x1f]{8,}", s):
            c = c.strip().replace("\r", "")
            if not c or NOISE.match(c):
                continue
            cjk = len(CJK.findall(c))
            if not (cjk >= 4 or (cjk >= 1 and len(c) >= 20 and re.search(r"[A-Za-z]{6,}", c))):
                continue
            rows.append((len(SANE.findall(c)) / max(1, len(c)), c))
        keep = [c for d, c in rows if d >= 0.10]
        if sum(len(x) for x in keep) < 2000:      # 密度筛太狠就放宽一档
            keep = [c for d, c in rows if d >= 0.06]
        seen, ded = set(), []
        for c in keep:
            k = c[:60]
            if k in seen:
                continue
            seen.add(k)
            ded.append(c)
        score = sum(len(CJK.findall(c)) for c in ded)
        if score > best_score:
            best_score, best = score, ded
    return "\n".join(best)


def repair_mojibake(t):
    """修复「UTF-8 字节被按 GBK 解码」产生的乱码（如 缁忛攢 → 经销）。

    老 .doc 的二进制里既有 UTF-16 也有 UTF-8 文本流，用 GB18030 解会得到
    形似中文但没有意义的假字，重编码回字节再按 UTF-8 解即可还原。
    同一文件里两种编码可能混排，所以**逐行**判断，别整段一起修。
    """
    out = []
    for line in (t or "").split("\n"):
        cand = line
        if not re.search(r"[的就是在合同协议条款]", line):
            try:
                r = line.encode("gb18030", "ignore").decode("utf-8", "ignore")
                if len(SANE.findall(r)) > len(SANE.findall(line)):
                    cand = r
            except Exception:
                pass
        out.append(cand)
    return "\n".join(out)


def extract_pdf_page_images(path, slug, src_dir):
    """扫描件（无字体层）降级：把页面图片导出为 JPG/PNG，供人工或视觉模型读。

    先走 pypdf 的 page.images；pypdf 打不开整个 PDF 时（扫描件常见
    「Could not read Boolean object」），退回按字节扫 JPEG 流（扫描页基本是 DCTDecode）。
    """
    out = []
    if PdfReader is not None:
        try:
            r = PdfReader(path)
            for i, page in enumerate(r.pages):
                try:
                    imgs = list(getattr(page, "images", []) or [])
                except Exception as e:
                    log("    ! 第%d页取图失败: %s" % (i + 1, str(e)[:60]))
                    continue
                for im in imgs:
                    data = getattr(im, "data", None)
                    if not data:
                        continue
                    name = str(getattr(im, "name", "") or "")
                    ext = os.path.splitext(name)[1].lower()
                    if ext not in (".png", ".jpg", ".jpeg"):
                        ext = ".png"
                    fp = os.path.join(src_dir, "%s_p%d%s" % (slug, i + 1, ext))
                    if not (os.path.exists(fp) and os.path.getsize(fp) == len(data)):
                        with open(fp, "wb") as f:
                            f.write(data)
                    out.append(fp)
        except Exception as e:
            log("    ! pypdf 读取失败（%s），改按字节扫 JPEG" % str(e)[:60])
    if out:
        return out

    # 字节级兜底：扫 JPEG SOI/EOI
    raw = open(path, "rb").read()
    idx = 0
    n = 0
    while True:
        s = raw.find(b"\xff\xd8\xff", idx)
        if s < 0:
            break
        e = raw.find(b"\xff\xd9", s + 3)
        if e < 0:
            break
        blob = raw[s : e + 2]
        if len(blob) < 20000:   # 太小的多半是图标/水印
            idx = e + 2
            continue
        n += 1
        fp = os.path.join(src_dir, "%s_p%d.jpg" % (slug, n))
        if not (os.path.exists(fp) and os.path.getsize(fp) == len(blob)):
            with open(fp, "wb") as f:
                f.write(blob)
        out.append(fp)
        idx = e + 2
    if out:
        log("    → 字节扫描导出 %d 张页图" % len(out))
    return out


def extract(path, slug="", src_dir=""):
    """返回 (正文, 状态, 导出的页面图片列表)"""
    e = os.path.splitext(path)[1].lower()
    if e == ".docx":
        return extract_docx(path), "ok", []
    if e == ".pdf":
        try:
            t = extract_pdf(path)
        except Exception as ex:
            log("    ! 文本抽取失败（%s），改导出页图" % str(ex)[:60])
            t = ""
        if t.strip():
            return t, "ok", []
        imgs = extract_pdf_page_images(path, slug, src_dir) if (slug and src_dir) else []
        return "", ("needs-ocr" if imgs else "no-text"), imgs
    if e == ".doc":
        t = repair_mojibake(extract_doc_binary(path))
        return t, ("crude" if t.strip() else "no-text"), []
    return "", "unsupported", []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "contracts"))
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--include-attachments", action="store_true", help="连授权书/委托书/声明书一起收")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    scan_root = os.path.abspath(args.dir)
    if not os.path.isdir(scan_root):
        log("✗ 目录不存在: %s" % scan_root)
        sys.exit(1)
    out_root = os.path.abspath(args.out)
    src_dir = os.path.join(out_root, "_sources")
    inbox_dir = os.path.join(out_root, "_inbox")
    manifest_path = os.path.join(inbox_dir, "manifest.json")

    existing = {}
    if os.path.exists(manifest_path):
        try:
            for it in json.load(open(manifest_path, encoding="utf-8")).get("items", []):
                existing[it["path"]] = it
        except Exception as e:
            log("! manifest 读取失败，按空处理: %s" % e)

    # 已入库合同的来源文件名（data/contracts/*.json 的 source_file）
    taken = set()
    for f in os.listdir(out_root):
        if f.endswith(".json"):
            try:
                sp = json.load(open(os.path.join(out_root, f), encoding="utf-8"))
                for k in ("source_file", "sourceFile"):
                    if sp.get(k):
                        taken.add(os.path.basename(str(sp[k])))
            except Exception:
                pass

    cands = []
    skipped = {"temp": 0, "attachment": 0, "neg": 0, "nokw": 0}
    for dp, dns, fns in os.walk(scan_root):
        dns[:] = [d for d in dns if not d.startswith(".") and d != "_sources"]
        for fn in sorted(fns):
            e = os.path.splitext(fn)[1].lower()
            if e not in EXTS:
                continue
            if TEMP.search(fn):
                skipped["temp"] += 1
                continue
            if not args.all:
                if NEG.search(fn):
                    skipped["neg"] += 1
                    continue
                if not KW.search(fn):
                    skipped["nokw"] += 1
                    continue
                if ATTACH.search(fn) and not args.include_attachments:
                    skipped["attachment"] += 1
                    continue
            cands.append(os.path.join(dp, fn))
    cands.sort()
    if args.limit:
        cands = cands[: args.limit]

    log("扫描根: %s" % scan_root)
    log("疑似合同: %d 份（--all=%s）｜跳过：临时文件 %d · 附件类 %d · 非合同词 %d · 无合同词 %d"
        % (len(cands), args.all, skipped["temp"], skipped["attachment"], skipped["neg"], skipped["nokw"]))
    if args.dry_run:
        for c in cands:
            log("  · %s" % os.path.relpath(c, scan_root))
        return

    os.makedirs(src_dir, exist_ok=True)
    os.makedirs(inbox_dir, exist_ok=True)

    items = []
    dumps = {}
    seen_sha = {}
    slug_owner = {}
    n_new = n_cached = n_fail = 0
    for path in cands:
        rel = os.path.relpath(path, scan_root)
        try:
            sha = sha1_file(path)
        except Exception as e:
            log("✗ 读取失败 %s: %s" % (rel, e))
            items.append({"path": path, "rel": rel, "status": "read-error", "error": str(e)})
            n_fail += 1
            continue

        prev = existing.get(path)
        slug = sanitize(os.path.splitext(os.path.basename(path))[0])
        old = slug_owner.get(slug)
        if old and old != path:          # 同名不同文件（如 xx.docx 与 xx.pdf）撞车 → 加 hash 区分
            slug = "%s_%s" % (slug, sha[:6])
        slug_owner.setdefault(slug, path)
        txt_path = os.path.join(src_dir, slug + ".txt")

        if prev and prev.get("sha1") == sha and not args.refresh and os.path.exists(prev.get("txt", "")):
            it = dict(prev)
            it["cached"] = True
            items.append(it)
            dumps[slug] = it
            seen_sha.setdefault(sha, slug)
            n_cached += 1
            continue

        try:
            text, status, images = extract(path, slug, src_dir)
        except Exception as e:
            text, status, images = "", "error:" + str(e)[:80], []
        text = text.strip()
        chars = len(text)
        if status == "ok" and chars < 200:
            status = "too-short"

        with open(txt_path, "w", encoding="utf-8") as f:
            f.write("# 来源：%s\n# 抽取时间：%s\n\n%s\n" % (path, datetime.datetime.now().isoformat(timespec="seconds"), text))

        it = {
            "path": path,
            "rel": rel,
            "ext": os.path.splitext(path)[1].lower(),
            "size": os.path.getsize(path),
            "mtime": datetime.datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds"),
            "sha1": sha,
            "status": status,
            "chars": chars,
            "slug": slug,
            "txt": txt_path,
            "images": images,
            "already_in_wiki": os.path.basename(path) in taken,
            "dup_of": seen_sha.get(sha),
            "cached": False,
        }
        seen_sha.setdefault(sha, slug)
        items.append(it)
        dumps[slug] = it
        n_new += 1
        log("  + %-70s %-8s %6d 字%s" % (rel[:70], status, chars, (" + %d 张页图" % len(images)) if images else ""))

    # 同名去重（文件名去掉扩展名 + 去掉副本后缀后相同的，标 dup_of_name）
    by_stem = {}
    for it in items:
        stem = os.path.splitext(it["rel"])[0].lower()
        stem = re.sub(r"[ _\-()]*(副本|\d+|\b1\b|v\d+)$", "", stem).strip()
        by_stem.setdefault(stem, []).append(it)
    dup_groups = {k: [x["rel"] for x in v] for k, v in by_stem.items() if len(v) > 1}

    manifest = {
        "scan_root": scan_root,
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "generator": "scripts/wiki-contract-intake.py",
        "counts": {
            "candidates": len(cands),
            "new": n_new,
            "cached": n_cached,
            "failed": n_fail,
            "ok": sum(1 for i in items if i.get("status") in ("ok", "crude")),
            "no_text": sum(1 for i in items if i.get("status") in ("no-text", "needs-ocr")),
            "needs_ocr": sum(1 for i in items if i.get("status") == "needs-ocr"),
            "already_in_wiki": sum(1 for i in items if i.get("already_in_wiki")),
        },
        "dup_groups": dup_groups,
        "taken_source_files": sorted(taken),
        "items": items,
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    log("")
    log("清单: %s" % manifest_path)
    log("正文: %s/（%d 份）" % (src_dir, len(dumps)))
    log("统计: 新抽 %d · 缓存 %d · 失败 %d · 无正文 %d · 已在 wiki %d · 同名重复组 %d"
        % (n_new, n_cached, n_fail, manifest["counts"]["no_text"], manifest["counts"]["already_in_wiki"], len(dup_groups)))
    if dup_groups:
        log("同名重复（人工确认是否同一份）:")
        for k, v in list(dup_groups.items())[:10]:
            log("  · %s" % " ; ".join(os.path.basename(x) for x in v))


if __name__ == "__main__":
    main()
