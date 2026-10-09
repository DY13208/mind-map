#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给一批资料目录（如 D:\\法务 各公司资质）生成「文件 ↔ 本地绝对路径」索引。

用途：图谱记录里只放关键证照与目录路径，完整清单落成 CSV/Markdown，
既满足「每个文件都能定位」，又不把上千行塞进 wiki。

用法：
  python scripts/fawu-file-index.py --dir "C:\\Users\\yr\\Desktop\\法务" --out-dir data/fawu
输出：
  <out-dir>/文件路径索引.csv     —— 公司, 相对路径, 文件名, 类型, 大小KB, 修改时间, 本地绝对路径
  <out-dir>/文件路径索引.md      —— 按公司分组的 Markdown 表格（便于直接贴进 wiki）
"""
import argparse
import csv
import datetime
import os

SKIP_DIRS = {".Temp", ".WeDrive", "$RECYCLE.BIN", "System Volume Information"}
SKIP_EXT = {".lnk", ".tmp"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out-dir", default="data/fawu")
    ap.add_argument("--group-depth", type=int, default=2,
                    help="以第几层目录作为「公司」分组（默认 2，即 <root>/<顶层>/<公司>）")
    args = ap.parse_args()

    root = os.path.abspath(args.dir)
    if not os.path.isdir(root):
        raise SystemExit("目录不存在: %s" % root)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    rows = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in sorted(fns):
            if os.path.splitext(fn)[1].lower() in SKIP_EXT:
                continue
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, root)
            parts = rel.split(os.sep)
            group = os.sep.join(parts[: args.group_depth]) if len(parts) > args.group_depth else "(根)"
            try:
                st = os.stat(p)
                size_kb = round(st.st_size / 1024.0, 1)
                mtime = datetime.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
            except OSError:
                size_kb, mtime = "", ""
            rows.append({
                "公司": group,
                "相对路径": rel,
                "文件名": fn,
                "类型": os.path.splitext(fn)[1].lower().lstrip("."),
                "大小KB": size_kb,
                "修改时间": mtime,
                "本地绝对路径": p,
            })

    rows.sort(key=lambda r: (r["公司"], r["相对路径"]))

    csv_path = os.path.join(out_dir, "文件路径索引.csv")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["公司", "相对路径", "文件名", "类型", "大小KB", "修改时间", "本地绝对路径"])
        w.writeheader()
        w.writerows(rows)

    md_path = os.path.join(out_dir, "文件路径索引.md")
    by_group = {}
    for r in rows:
        by_group.setdefault(r["公司"], []).append(r)
    lines = ["# 文件 ↔ 本地路径索引", "",
             "根目录：`%s`" % root,
             "合计 %d 个文件、%d 个分组｜生成时间 %s" % (
                 len(rows), len(by_group), datetime.datetime.now().strftime("%Y-%m-%d %H:%M")), ""]
    for g in sorted(by_group):
        items = by_group[g]
        lines.append("## %s（%d 个文件）" % (g, len(items)))
        lines.append("")
        lines.append("目录：`%s`" % os.path.join(root, g))
        lines.append("")
        lines.append("| 文件 | 类型 | 大小KB | 修改时间 |")
        lines.append("|---|---|---|---|")
        for r in items:
            lines.append("| %s | %s | %s | %s |" % (r["文件名"], r["类型"], r["大小KB"], r["修改时间"]))
        lines.append("")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print("文件 %d 个 / 分组 %d 个" % (len(rows), len(by_group)))
    print("CSV : %s" % csv_path)
    print("MD  : %s" % md_path)


if __name__ == "__main__":
    main()
