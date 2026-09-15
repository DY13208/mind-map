# -*- coding: utf-8 -*-
import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

d = json.load(open(r'D:\liangce\mind-map\.tmp\outline_bpapl7vv_live.json', encoding='utf-8'))
print('room:', d.get('room_key'), 'version:', d.get('version'), 'title:', d.get('title'))
outline = d.get('outline')
print('outline type:', type(outline))
if isinstance(outline, str):
    outline = json.loads(outline)

# outline may be a dict {children: [...]} or a root node or list
if isinstance(outline, list):
    roots = outline
elif isinstance(outline, dict):
    # if it has children/title treat as root node
    roots = [outline]
else:
    roots = []

TARGET = 'e2d6a645-8d2f-49fa-a27d-ae5ef385a703'

def allnodes(n, depth, trail):
    yield n, depth, trail
    for c in n.get('children', []):
        yield from allnodes(c, depth + 1, trail + [n.get('uid')])

# 1) ancestors path
anc = None
for r in roots:
    for n, depth, trail in allnodes(r, 0, []):
        if n.get('uid') == TARGET:
            # rebuild ancestor titles via uid map
            uid2node = {}
            def idx(n):
                uid2node[n.get('uid')] = n
                for c in n.get('children', []):
                    idx(c)
            for rr in roots:
                idx(rr)
            anc = [uid2node[u] for u in trail]
            anc = anc[1:] if anc else anc  # drop artificial root if any
            print('=== ANCESTOR PATH ===')
            for a in anc:
                print('  ', a.get('uid'), '|', a.get('title'))
            break

# 2) subtree of target (children with detail)
def find(n, uid):
    if n.get('uid') == uid:
        return n
    for c in n.get('children', []):
        r = find(c, uid)
        if r:
            return r
    return None

tgt = None
for r in roots:
    tgt = find(r, TARGET)
    if tgt:
        break

def dump(n, depth):
    uid = n.get('uid', '')
    title = n.get('title', '')
    note = n.get('note') or ''
    hl = n.get('hyperlink')
    data = n.get('data') or {}
    extra = []
    if note:
        extra.append('NOTE:' + note[:500])
    if hl:
        extra.append('HL:' + json.dumps(hl, ensure_ascii=False)[:500])
    if data:
        extra.append('DATA:' + json.dumps(data, ensure_ascii=False)[:800])
    print('  ' * depth + f"[{uid}] {title}" + (' | ' + ' || '.join(extra) if extra else ''))
    for c in n.get('children', []):
        dump(c, depth + 1)

print()
print('=== TARGET SUBTREE (D1 推广计划和预算) ===')
if tgt:
    dump(tgt, 0)
else:
    print('target not found in tree; raw search result below')

# print all keys of a sample node to understand fields
print()
print('=== SAMPLE NODE FIELDS ===')
def first_node(n):
    return n
samp = None
for r in roots:
    for n, depth, trail in allnodes(r, 0, []):
        samp = n
        break
    if samp:
        break
if samp:
    print(json.dumps(samp, ensure_ascii=False, indent=1)[:1500])
