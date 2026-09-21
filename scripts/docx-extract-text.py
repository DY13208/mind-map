#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
docx-extract-text.py —— 从 .docx 直接解 XML 取全文（无截断，含表格）

⚠️ 已被 scripts/docx-revisions.py 取代（后者兼容本脚本全部能力，且能正确处理修订记录）。
   本脚本运行时会先检测修订：若文档含 w:ins / w:del，**直接拒绝**并指向 docx-revisions.py，
   避免「原文+修订文混杂」被当成最终文本（例：上播前「15天」改「2天」会读成「152天」）。
   仅对不含修订的干净 docx 才继续输出。

用法：
  python3 scripts/docx-extract-text.py <file.docx> [--out <path.txt>] [--json <path.json>]

输出：
  纯文本（段落逐行）到 stdout 或 --out
  --json 时额外落结构化 JSON（paragraphs / tables）
"""
import argparse
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def para_text(p):
    """取段落纯文本。w:t 是文本；w:tab/br 还原为空白。"""
    buf = []
    for node in p.iter():
        tag = node.tag
        if tag == W + 't':
            buf.append(node.text or '')
        elif tag == W + 'tab':
            buf.append('\t')
        elif tag in (W + 'br', W + 'cr'):
            buf.append(' ')
    return ''.join(buf)


def para_style(p):
    ppr = p.find(W + 'pPr')
    if ppr is None:
        return None
    st = ppr.find(W + 'pStyle')
    if st is None:
        return None
    return st.get(W + 'val')


def walk(body, out_paras, out_tables, in_table=False):
    for child in body:
        tag = child.tag
        if tag == W + 'p':
            out_paras.append({
                'text': para_text(child),
                'style': para_style(child),
                'in_table': in_table,
            })
        elif tag == W + 'tbl':
            rows = []
            for tr in child.findall(W + 'tr'):
                cells = []
                for tc in tr.findall(W + 'tc'):
                    sub_p = []
                    sub_t = []
                    walk(tc, sub_p, sub_t, in_table=True)
                    cells.append('\n'.join(x['text'] for x in sub_p).strip())
                rows.append(cells)
            out_tables.append(rows)
        elif tag == W + 'sdt':  # 内容控件
            content = child.find(W + 'sdtContent')
            if content is not None:
                walk(content, out_paras, out_tables, in_table)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('--out')
    ap.add_argument('--json')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()

    if not os.path.isfile(a.file):
        sys.exit('file not found: ' + a.file)
    if not zipfile.is_zipfile(a.file):
        sys.exit('not a zip/docx: ' + a.file)

    with zipfile.ZipFile(a.file) as z:
        names = z.namelist()
        if 'word/document.xml' not in names:
            sys.exit('word/document.xml missing; names=%s' % names[:20])
        xml = z.read('word/document.xml')

    # 修订检测：含 tracked changes 时拒绝，避免把「原文+新文」当最终文本
    x = xml.decode('utf-8', 'ignore')
    n_ins, n_del = x.count('<w:ins '), x.count('<w:del ')
    if n_ins or n_del:
        sys.exit('该 docx 含修订记录（w:ins=%d / w:del=%d）。请改用：\n'
                 '  python3 scripts/docx-revisions.py "%s" --view final'
                 % (n_ins, n_del, a.file))

    root = ET.fromstring(xml)
    body = root.find(W + 'body')
    if body is None:
        sys.exit('no w:body')

    paras, tables = [], []
    walk(body, paras, tables)

    lines = []
    for p in paras:
        lines.append(p['text'])
    out = '\n'.join(lines)

    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, 'w', encoding='utf-8') as f:
            f.write(out)

    if a.json:
        os.makedirs(os.path.dirname(os.path.abspath(a.json)), exist_ok=True)
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump({'paragraphs': paras, 'tables': tables}, f,
                      ensure_ascii=False, indent=1)

    if not a.quiet:
        sys.stdout.write(out)

    sys.stderr.write('\n[docx-extract] paragraphs=%d tables=%d chars=%d\n'
                     % (len(paras), len(tables), len(out)))


if __name__ == '__main__':
    main()
