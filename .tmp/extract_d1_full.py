# -*- coding: utf-8 -*-
import json, io, sys, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

d = json.load(open(r'D:\liangce\mind-map\.tmp\full_bpapl7vv_live.json', encoding='utf-8'))
root = d['tree']
TARGETS = {
    'D1目标': 'e2d6a645-8d2f-49fa-a27d-ae5ef385a703',
    'A1站内计划': 'f426c6ef-159f-4795-8ed8-351463d31e46',
    '步骤1销售目标': 'dcceffd5-0b06-4566-ba38-6f8f58baa540',
    '步骤2费比ROI': '0ec28989-5c3e-42b9-a62b-0a2935431a68',
    '费比值': 'af5d79d9-c6a7-43df-bebc-2f594d38930f',
    '步骤3加购成本': 'f5e3ceb8-0149-4116-86e0-5738eb5552e7',
    '加购成本值': '086e9ca8-985a-4319-b9fa-6f98e1866e82',
    'P4父': 'f93182fc-6158-4e6d-a008-5d76cfc77336',
    'P1GMV-D1': 'e2c2721c-da11-465d-be71-8482ceb57c4b',
    '2026渠道目标': '0c2c7364-3e04-44dd-bbe2-5c8811e236a2',
    '销售日报表': 'fdb3a888-2115-4b78-a2f0-76c5adba1f03',
}

def strip_html(s):
    return re.sub(r'<[^>]+>', '', s or '').strip()

def find(n, uid):
    if n.get('data', {}).get('uid') == uid:
        return n
    for c in n.get('children', []):
        r = find(c, uid)
        if r:
            return r
    return None

for name, uid in TARGETS.items():
    n = find(root, uid)
    if not n:
        print(f'--- {name} [{uid}] NOT FOUND ---')
        continue
    data = n.get('data', {})
    title = strip_html(data.get('text', ''))
    print(f'=== {name} [{uid}] ===')
    print('  title:', title)
    # print all data keys excluding known noise
    keys = [k for k in data.keys() if k not in ('__fv', 'expand', 'richText', 'generalization', 'text', 'uid')]
    if keys:
        for k in keys:
            print(f'  data.{k}:', json.dumps(data[k], ensure_ascii=False)[:800])
    print()
