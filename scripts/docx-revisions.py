#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
docx-revisions.py —— 解析 .docx 的修订记录(tracked changes)与批注

背景：修订版 docx 里，<w:ins> 是新增、<w:del>/<w:delText> 是删除。若直接
拼 w:t 会得到「原文+新文」混杂的乱码（例：上播前「15天」改成「2天」会读成
「152天」）。本脚本同时输出三种视图：

  --view final   接受全部修订（= Word 的「最终状态」）← 默认，应作为提取依据
  --view original  拒绝全部修订（= Word 的「原始状态」）
  --view mark    带标记（[+新+] / [-旧-]），便于人工核对改了什么

用法：
  python3 scripts/docx-revisions.py <file.docx> [--view final|original|mark]
  python3 scripts/docx-revisions.py <file.docx> --out <path.txt> [--json <path.json>]
"""
import argparse
import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def para_text(p, view):
    """按视图提取段落文本。

    view=final    : 收 w:t（含 w:ins 内的），跳过 w:delText
    view=original : 收 w:t，但跳过 <w:ins> 子树里的；收 w:delText（即删除前的原文）
    view=mark     : 收 w:t，w:ins 内包 [+..+]，w:del 包 [-..-]
    """
    buf = []

    def rec(node, inside_ins=False, inside_del=False):
        for ch in node:
            tag = ch.tag
            if tag == W + 'ins':
                if view == 'original':
                    continue
                if view == 'mark':
                    buf.append('[+')
                rec(ch, inside_ins=True, inside_del=inside_del)
                if view == 'mark':
                    buf.append('+]')
                continue
            if tag == W + 'del':
                if view == 'final':
                    continue
                if view == 'mark':
                    buf.append('[-')
                rec(ch, inside_ins=inside_ins, inside_del=True)
                if view == 'mark':
                    buf.append('-]')
                continue
            if tag == W + 't':
                buf.append(ch.text or '')
                continue
            if tag == W + 'delText':
                if view == 'final':
                    continue
                buf.append(ch.text or '')
                continue
            if tag == W + 'tab':
                buf.append('\t')
                continue
            if tag in (W + 'br', W + 'cr'):
                buf.append(' ')
                continue
            rec(ch, inside_ins=inside_ins, inside_del=inside_del)

    rec(p)
    return ''.join(buf)


def para_style(p):
    ppr = p.find(W + 'pPr')
    if ppr is None:
        return None
    rpr = ppr.find(W + 'rPr')
    if rpr is not None:
        ins = rpr.find(W + 'ins')
        if ins is not None:
            return '__paraInserted__'
    st = ppr.find(W + 'pStyle')
    if st is None:
        return None
    return st.get(W + 'val')


def walk(body, out_paras, out_tables, view, in_table=False):
    for child in body:
        tag = child.tag
        if tag == W + 'p':
            out_paras.append({
                'text': para_text(child, view),
                'style': para_style(child),
                'in_table': in_table,
            })
        elif tag == W + 'tbl':
            rows = []
            for tr in child.findall(W + 'tr'):
                trpr = tr.find(W + 'trPr')
                row_ins = trpr is not None and trpr.find(W + 'ins') is not None
                if view == 'original' and row_ins:
                    continue
                cells = []
                for tc in tr.findall(W + 'tc'):
                    tcpr = tc.find(W + 'tcPr')
                    if view == 'original' and tcpr is not None and tcpr.find(W + 'cellIns') is not None:
                        cells.append('')
                        continue
                    if view == 'final' and tcpr is not None and tcpr.find(W + 'cellDel') is not None:
                        cells.append('')
                        continue
                    sub_p, sub_t = [], []
                    walk(tc, sub_p, sub_t, view, in_table=True)
                    cells.append('\n'.join(x['text'] for x in sub_p).strip())
                rows.append(cells)
            out_tables.append(rows)
        elif tag == W + 'sdt':
            c = child.find(W + 'sdtContent')
            if c is not None:
                walk(c, out_paras, out_tables, view, in_table)


def read_comments(z):
    if 'word/comments.xml' not in z.namelist():
        return []
    root = ET.fromstring(z.read('word/comments.xml'))
    out = []
    for c in root.findall(W + 'comment'):
        txt = ''.join(t.text or '' for t in c.iter(W + 't'))
        out.append({
            'id': c.get(W + 'id'),
            'author': c.get(W + 'author'),
            'date': c.get(W + 'date'),
            'text': txt.strip(),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('--view', default='final',
                    choices=['final', 'original', 'mark'])
    ap.add_argument('--out')
    ap.add_argument('--json')
    ap.add_argument('--comments', action='store_true')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args()

    if not os.path.isfile(a.file):
        sys.exit('file not found: ' + a.file)
    with zipfile.ZipFile(a.file) as z:
        xml = z.read('word/document.xml')
        comments = read_comments(z)

    root = ET.fromstring(xml)
    body = root.find(W + 'body')
    paras, tables = [], []
    walk(body, paras, tables, a.view)

    out = '\n'.join(p['text'] for p in paras)

    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, 'w', encoding='utf-8') as f:
            f.write(out)
    if a.json:
        os.makedirs(os.path.dirname(os.path.abspath(a.json)), exist_ok=True)
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump({'view': a.view, 'paragraphs': paras,
                       'tables': tables, 'comments': comments},
                      f, ensure_ascii=False, indent=1)

    if not a.quiet:
        sys.stdout.write(out)

    if a.comments and comments:
        sys.stderr.write('\n=== 批注 %d 条 ===\n' % len(comments))
        for c in comments:
            sys.stderr.write('  [%s] %s (%s): %s\n'
                             % (c['id'], c['author'], c['date'], c['text']))

    sys.stderr.write('\n[docx-revisions] view=%s paragraphs=%d tables=%d chars=%d comments=%d\n'
                     % (a.view, len(paras), len(tables), len(out), len(comments)))


if __name__ == '__main__':
    main()
