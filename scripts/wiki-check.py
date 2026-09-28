#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WIKI（知识库）接入自检 + 聪明程度评测。

三件事，一件一条命令：

  1) 服务层 —— wiki MCP 到底能不能调（列空间 / 列工具 / 真检索一次）
       python scripts/wiki-check.py

  2) 运行层 —— 脑图「运行」派出去的任务**真的会去查知识库吗**（探针任务 + 证据判定）
       python scripts/wiki-check.py --bridge http://192.168.1.114:8799

  3) 聪明程度 —— 跑题集：检索命中率 / 关键点覆盖 / 该拒答时会不会瞎编
       python scripts/wiki-check.py --eval                    # 只测检索层（快）
       python scripts/wiki-check.py --eval --bridge http://... # 连「作答」一起测（每题派一次任务，慢）

题集在 scripts/wiki-eval-questions.json，可以自己加题。

判据说明（重要）：
  · 运行层探针问的是「知识库里有哪些空间」—— 空间名（含人名/emoji）模型不可能凭空知道，
    答案里命中 2 个以上空间名，就**确凿证明**那次运行调用了知识库工具，不是靠模型记忆。
  · 聪明程度分三层看，别混在一起：检索不到 ≠ 答得不好。
      检索层：gold 文档有没有进 top-k（命中率@1/@3、MRR）
      作答层：答案有没有覆盖 must 里的关键点
      拒答层：知识库里没有的问题，会不会编
"""
import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
# 内网自签证书：把 ctx 交给 HTTPSHandler，别在 open() 上传 context（urllib 不认这个参数）
OP = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPSHandler(context=CTX),
)
HERE = os.path.dirname(os.path.abspath(__file__))
QUESTIONS = os.path.join(HERE, 'wiki-eval-questions.json')
MCP_CFG = os.path.join(os.path.expanduser('~'), '.workbuddy', 'mcp.json')


def out(msg=''):
    print(msg)
    sys.stdout.flush()


# ---------------------------------------------------------------- MCP（服务层）
class WikiMcp:
    """直连 knowledge-mcp：JSON-RPC over HTTP（可能回 SSE，两种都吃）"""

    def __init__(self, url, token):
        self.url = url
        self.token = token
        self.sid = ''
        self.seq = 0

    def _post(self, method, params=None, timeout=40):
        self.seq += 1
        body = {'jsonrpc': '2.0', 'id': self.seq, 'method': method}
        if params is not None:
            body['params'] = params
        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        }
        if self.token:
            headers['Authorization'] = 'Bearer %s' % self.token
        if self.sid:
            headers['Mcp-Session-Id'] = self.sid
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(),
                                     method='POST', headers=headers)
        with OP.open(req, timeout=timeout) as r:
            sid = r.headers.get('Mcp-Session-Id')
            raw = r.read().decode('utf-8', 'replace')
        if sid:
            self.sid = sid
        text = raw.strip()
        if text.startswith('{'):
            return json.loads(text)
        for line in text.splitlines():
            if line.startswith('data:'):
                chunk = line[5:].strip()
                if chunk:
                    return json.loads(chunk)
        return {}

    def init(self):
        return self._post('initialize', {
            'protocolVersion': '2025-06-18',
            'capabilities': {},
            'clientInfo': {'name': 'wiki-check', 'version': '1.0'},
        })

    def tools(self):
        res = self._post('tools/list', {})
        return [t.get('name') for t in ((res.get('result') or {}).get('tools') or [])]

    def call(self, name, args=None):
        res = self._post('tools/call', {'name': name, 'arguments': args or {}})
        if res.get('error'):
            return None, json.dumps(res['error'], ensure_ascii=False)
        content = (res.get('result') or {}).get('content') or []
        text = content[0].get('text') if content else json.dumps(res, ensure_ascii=False)
        try:
            return json.loads(text), text
        except Exception:
            return None, text


def load_mcp_conf():
    if not os.path.isfile(MCP_CFG):
        return None
    conf = json.load(open(MCP_CFG, encoding='utf-8'))
    ent = (conf.get('mcpServers') or {}).get('mind-map-wiki')
    if not ent:
        return None
    token = ((ent.get('headers') or {}).get('Authorization') or '').replace('Bearer ', '')
    return {'url': ent.get('url'), 'token': token}


# ---------------------------------------------------------------- 桥接
def bridge_get(base, path, timeout=25):
    try:
        with OP.open(base.rstrip('/') + path, timeout=timeout) as r:
            body = r.read().decode('utf-8', 'replace')
        try:
            return r.status, json.loads(body)
        except Exception:
            return r.status, body[:300]
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8', 'replace'))
        except Exception:
            return e.code, ''
    except Exception as e:
        return 0, str(e)[:140]


def bridge_post(base, path, payload, timeout=40):
    req = urllib.request.Request(
        base.rstrip('/') + path, data=json.dumps(payload).encode(), method='POST',
        headers={'Content-Type': 'application/json'})
    try:
        with OP.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8', 'replace'))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8', 'replace'))
        except Exception:
            return e.code, ''
    except Exception as e:
        return 0, str(e)[:140]


def pick_gateway(base):
    """桥接上可能有多个 WorkBuddy 会话：显式挑一个并一路带上，
    否则派发走 A 会话、查任务查的是 B 会话，永远找不到（踩过）"""
    st, gws = bridge_get(base, '/api/gateways')
    if st != 200 or not isinstance(gws, dict):
        return ''
    sessions = gws.get('gateways') or []
    return (sessions[0] or {}).get('url') or '' if sessions else ''


def wait_job(base, gateway, job_id, wait=240):
    """等任务跑完，返回 (state, 回答全文)。"""
    state, detail = '', ''
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(5)
        q = '/api/jobs?all=1' + ('&gateway=%s' % urllib.parse.quote(gateway, safe='') if gateway else '')
        _st, body = bridge_get(base, q)
        jobs = (body or {}).get('jobs') if isinstance(body, dict) else None
        if not jobs:
            continue
        cur = next((j for j in jobs if j.get('id') == job_id), None)
        if not cur:
            continue
        state = cur.get('state') or cur.get('status') or ''
        detail = str(cur.get('detail') or '')
        if state not in ('working', 'busy', 'active', 'pending', 'running') and cur.get('alive') is not True:
            break
    text = detail
    tq = '/api/transcript?id=%s' % job_id + ('&gateway=%s' % urllib.parse.quote(gateway, safe='') if gateway else '')
    _st2, tr = bridge_get(base, tq, timeout=60)
    if isinstance(tr, dict) and tr.get('ok') and tr.get('text'):
        text = tr['text']
    return state, text


def runtime_probe(base, space_names, wait=240, keep=False):
    """运行层：派一条探针任务，看它会不会真去查知识库"""
    out('-' * 74)
    out('【运行层】派一条探针任务到 %s' % base)
    gateway = pick_gateway(base)
    if not gateway:
        out('  ✗ 桥接不可用或没有可派的 WorkBuddy 会话（桌面版没开？）')
        return False
    out('  会话：%s' % gateway)

    prompt = (
        '【知识库接入探针 · 只做这一件事】\n'
        '请调用你的知识库（wiki）工具，回答下面两个问题，不要靠记忆猜、不要读本地文件：\n'
        '1) 这个知识库里一共有几个空间（space）？\n'
        '2) 把这些空间的名字逐个列出来。\n\n'
        '输出格式（严格照抄，不要多写别的）：\n'
        'SPACES_COUNT: <数字>\n'
        'SPACES: <名字1> | <名字2> | ...\n'
        'TOOL_USED: <你调用的工具名，逗号分隔；一个都没调用就写 none>'
    )
    name = 'wiki 接入探针 · %s' % time.strftime('%m-%d %H:%M')
    if keep:
        prompt += '\n（这是一次接入自检，结果只用于验证工具链，不需要写任何文件。）'
    st, resp = bridge_post(base, '/api/dispatch',
                           {'prompt': prompt, 'name': name, 'gateway': gateway})
    if st != 200 or not isinstance(resp, dict) or resp.get('ok') is False:
        out('  ✗ 派发失败：%s %s' % (st, json.dumps(resp, ensure_ascii=False)[:200]))
        return False
    job = resp.get('job') or resp
    job_id = job.get('id') or job.get('jobId') or ''
    out('  已派发 job=%s，等它跑完（最多 %ds）…' % (job_id, wait))
    state, text = wait_job(base, gateway, job_id, wait=wait)

    out('  任务状态：%s' % (state or '未知'))
    out('  回答片段：%s' % (text.replace('\n', ' ')[:260] or '（没取到回答）'))
    hits = [n for n in space_names if n and n in text]
    out('  证据：命中知识库空间名 %d 个 %s' % (len(hits), hits[:6]))
    if len(hits) >= 2:
        out('  ✓ 结论：这次运行**确实调用了知识库**（空间名模型编不出来）')
        return True
    out('  ✗ 结论：没看到知识库证据。可能原因：')
    out('      1) 执行那台的 WorkBuddy 没注册 wiki MCP —— 在它的 Connections 里加上：')
    out('         %s' % (GLOBAL_CONF.get('url') if GLOBAL_CONF else '(见 ~/.workbuddy/mcp.json)'))
    out('      2) 提示词没让它查 —— 当前运行提示词里**完全没提知识库**，全靠模型自觉')
    return False


# ---------------------------------------------------------------- 聪明程度
def eval_retrieval(mcp, questions, topk=5):
    """每题跑两遍：raw = 问句原文；kw = 题集里给的短关键词。
    现在这个检索器是关键词式的，长问句基本 0 命中 —— 两列一摆就看出来了。"""
    rows = []
    for item in questions:
        gold = item.get('gold') or []

        def run(query):
            if not query:
                return []
            got, _raw = mcp.call('wiki_search', {'query': query, 'limit': topk})
            return [str(i.get('title') or '') for i in ((got or {}).get('items') or [])]

        def rank_of(titles):
            for idx, title in enumerate(titles, 1):
                if any(g and (g in title or title in g) for g in gold):
                    return idx
            return 0

        raw_titles = run(item['q'])
        kw_titles = run(item.get('kw'))
        rows.append({
            'q': item['q'],
            'kw': item.get('kw') or '',
            'type': item.get('type') or 'positive',
            'gold': gold,
            'raw_titles': raw_titles,
            'kw_titles': kw_titles,
            'raw_rank': rank_of(raw_titles),
            'kw_rank': rank_of(kw_titles),
            'must': item.get('must') or [],
        })
    return rows


def report_retrieval(rows):
    pos = [r for r in rows if r['type'] == 'positive']
    neg = [r for r in rows if r['type'] == 'negative']

    def rate(key, upto=None):
        hit = [r for r in pos if r[key] and (upto is None or r[key] <= upto)]
        return len(hit), len(pos)

    out('-' * 74)
    out('【聪明程度 · 检索层】只看标题命不命中，和作答质量分开算')
    out('  %-34s %-8s %-8s %s' % ('问题', '问句原文', '短关键词', '关键词那次 top3'))
    for r in rows:
        raw = '空' if not r['raw_titles'] else ('✓%d' % r['raw_rank'] if r['raw_rank'] else '✗')
        kw = '空' if not r['kw_titles'] else ('✓%d' % r['kw_rank'] if r['kw_rank'] else '✗')
        if r['type'] == 'negative':
            raw = raw + '✓' if raw in ('空', '✗') else raw
            kw = kw + '✓' if kw in ('空', '✗') else kw
        out('  %-34s %-8s %-8s %s'
            % (r['q'][:32], raw, kw, ' / '.join(t[:14] for t in r['kw_titles'][:3])))
    out()
    for key, label in (('raw_rank', '问句原文'), ('kw_rank', '短关键词')):
        a1, n = rate(key, 1)
        a3, _ = rate(key, 3)
        mrr = sum((1.0 / r[key]) for r in pos if r[key]) / len(pos) if pos else 0
        out('  %s：命中@1 %d/%d（%.0f%%）· 命中@3 %d/%d · MRR %.2f'
            % (label, a1, n, 100.0 * a1 / n if n else 0, a3, n, mrr))
    if neg:
        out('  负例 %d 题（该查不到）：问句原文空 %d 题 · 短关键词空 %d 题'
            % (len(neg),
               len([r for r in neg if not r['raw_titles']]),
               len([r for r in neg if not r['kw_titles']])))
    out()
    out('  怎么读这三行：')
    out('   · 问句原文低、短关键词高 → **检索器不吃自然语言**，agent 必须先拆词（当前就是这样）')
    out('   · 两列都低 → 内容没进索引 / 分块有问题，跟模型无关')
    out('   · 命中了但答案不对 → 是模型读长文档的能力问题，别再调检索')


def check_answer(text, must_groups):
    """must 支持 [[同义词1,同义词2], ...] —— 任一同义词出现算过；也接受扁平字符串"""
    passed, missing = [], []
    for item in must_groups or []:
        alts = item if isinstance(item, list) else [item]
        if any(str(a) in text for a in alts):
            passed.append(alts[0])
        else:
            missing.append(alts[0])
    return passed, missing


def main():
    ap = argparse.ArgumentParser(description='WIKI 接入自检 + 聪明程度评测')
    ap.add_argument('--bridge', default='', help='执行主机桥接地址，如 http://192.168.1.114:8799')
    ap.add_argument('--eval', action='store_true', help='跑题集（聪明程度）')
    ap.add_argument('--answer', action='store_true', help='评测时也派任务让 WorkBuddy 作答（慢）')
    ap.add_argument('--questions', default=QUESTIONS)
    ap.add_argument('--wait', type=int, default=240)
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    conf = load_mcp_conf()
    out('=' * 74)
    out('【服务层】知识库 MCP')
    if not conf or not conf.get('url'):
        out('  ✗ 本机 ~/.workbuddy/mcp.json 里没有 mind-map-wiki —— 这台调不了知识库')
        return 1
    out('  地址：%s' % conf['url'])
    mcp = WikiMcp(conf['url'], conf['token'])
    try:
        mcp.init()
        tools = mcp.tools()
    except Exception as e:
        out('  ✗ 连不上 / 握手失败：%s' % str(e)[:140])
        return 1
    out('  ✓ 握手成功，工具 %d 个：%s' % (len(tools), ', '.join(tools)))

    spaces, raw = mcp.call('wiki_spaces')
    names = [s.get('name') for s in ((spaces or {}).get('items') or [])]
    if spaces:
        out('  ✓ 空间 %d 个：%s' % (len(names), '、'.join(names[:6]) + ('…' if len(names) > 6 else '')))
    else:
        out('  ✗ wiki_spaces 失败：%s' % (raw or '')[:160])
    got, raw2 = mcp.call('wiki_search', {'query': 'SOP 流程', 'limit': 3})
    hits = ((got or {}).get('items') or [])
    out('  %s 试检索「SOP 流程」→ %d 条命中%s'
        % ('✓' if hits else '✗', len(hits), ('（' + ' / '.join(str(h.get("title")) for h in hits[:3]) + '）') if hits else ('：' + (raw2 or '')[:120])))
    cancal, raw3 = mcp.call('canonical_list')
    if cancal is None or (isinstance(cancal, dict) and cancal.get('error')):
        detail = (cancal or {}).get('error') if isinstance(cancal, dict) else (raw3 or '')
        out('  ⚠ canonical_list（标准知识清单）报错：%s' % json.dumps(cancal, ensure_ascii=False)[:150] if cancal else ('  ⚠ canonical_list 失败：%s' % (raw3 or '')[:150]))
        out('     → 这是知识库那边的问题（不是运行侧）：容器里 /data/knowledge 下的房间目录没权限')
    else:
        items = cancal.get('items') or cancal.get('docs') or []
        out('  ✓ canonical 清单 %d 条' % len(items))

    global GLOBAL_CONF
    GLOBAL_CONF = conf

    if args.bridge:
        runtime_probe(args.bridge, names, wait=args.wait)

    if args.eval:
        if not os.path.isfile(args.questions):
            out('题集不存在：%s' % args.questions)
            return 1
        questions = json.load(open(args.questions, encoding='utf-8'))
        out()
        out('【聪明程度】题集 %s（%d 题）' % (os.path.basename(args.questions), len(questions)))
        rows = eval_retrieval(mcp, questions)
        report_retrieval(rows)
        if args.answer and args.bridge:
            out()
            out('【聪明程度 · 作答层】每题派一次任务给 %s（慢）' % args.bridge)
            gateway = pick_gateway(args.bridge)
            out('  会话：%s' % (gateway or '（没拿到会话，可能派不出去）'))
            for r in rows:
                q = r['q']
                gold = r['gold'] or []
                prompt = (
                    '【知识库作答评测】只用知识库（wiki 工具）里的内容回答，不要用模型记忆、不要编。\n'
                    '问题：%s\n\n'
                    '输出格式：\n答案：<尽量简短>\n出处：<用到的文档标题，多个用 / 分隔；确实查不到就写「知识库里没有」>'
                    % q
                )
                st, resp = bridge_post(args.bridge, '/api/dispatch',
                                       {'prompt': prompt, 'name': 'wiki 评测 · %s' % q[:20],
                                        'gateway': gateway})
                job = (resp or {}).get('job') or resp or {}
                jid = job.get('id') or ''
                if not jid:
                    out('  %-40s 派发失败：%s' % (q[:38], json.dumps(resp, ensure_ascii=False)[:90]))
                    continue
                _state, text = wait_job(args.bridge, gateway, jid, wait=args.wait)
                if not text:
                    out('  %-40s 没等到回答（取全文失败），这次不算分' % q[:38])
                    continue
                if r['type'] == 'negative':
                    refused = any(w in text for w in ('知识库里没有', '没有找到', '未找到', '查不到', '没有相关'))
                    out('  [负例] %-34s %s' % (q[:32],
                        '✓ 如实说没有' if refused else '✗ 可能编了：' + text[:70].replace('\n', ' ')))
                    continue
                passed, missing = check_answer(text, r['must'])
                out('  %-40s 关键点 %d/%d%s'
                    % (q[:38], len(passed), len(passed) + len(missing),
                       ('  缺：' + '、'.join(missing)) if missing else '  ✓'))
                if gold and not any(g in text for g in gold):
                    out('      ⚠ 出处里没提到 gold 文档：%s ｜ 回答：%s'
                        % (' / '.join(gold), text[:80].replace('\n', ' ')))
    return 0


GLOBAL_CONF = None

if __name__ == '__main__':
    raise SystemExit(main())
