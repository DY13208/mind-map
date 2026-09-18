
from pathlib import Path
import json, os, subprocess, hashlib, urllib.request, concurrent.futures

root = Path(r'D:\mind-map')
os.chdir(root)

def load_env():
    env = {}
    for line in (root / '.env').read_text(encoding='utf-8', errors='replace').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env

ENV = load_env()
SECRET = ENV.get('KNOWLEDGE_MCP_JWT_SECRET') or ENV.get('KNOWLEDGE_MCP_JWT_SECRET')
assert SECRET, 'missing KNOWLEDGE_MCP_JWT_SECRET'

# mint via node inline
MINT_JS = r"""
const { signToken } = require('./integrations/knowledge-mcp/src/auth/jwt');
const secret = process.env.KNOWLEDGE_MCP_JWT_SECRET;
const userId = process.argv[2];
const { token } = signToken({ userId, secret, ttlSec: 180, iss: 'openclaw-liangce', aud: 'knowledge-mcp' });
process.stdout.write(token);
"""
(root / 'scripts' / '_mint_kmcp.js').write_text(MINT_JS, encoding='utf-8')

def mint(uid: str) -> str:
    e = os.environ.copy()
    e['KNOWLEDGE_MCP_JWT_SECRET'] = SECRET
    return subprocess.check_output(['node', 'scripts/_mint_kmcp.js', uid], env=e, text=True).strip()

def rpc(token: str, method: str, params=None, id_=1):
    body = json.dumps({'jsonrpc': '2.0', 'id': id_, 'method': method, 'params': params or {}}).encode()
    req = urllib.request.Request(
        'http://127.0.0.1:18792/mcp',
        data=body,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def call_tool(token, name, args):
    res = rpc(token, 'tools/call', {'name': name, 'arguments': args})
    if 'error' in res:
        return {'error': res['error']}
    content = (res.get('result') or {}).get('content') or []
    text = content[0].get('text') if content else ''
    try:
        return json.loads(text)
    except Exception:
        return {'raw': text, 'isError': (res.get('result') or {}).get('isError')}

# DB memberships
q = "select user_id, room_key, role from room_members limit 80;"
out = subprocess.check_output(
    ['docker', 'exec', 'mind-map-postgres-1', 'psql', '-U', 'postgres', '-d', 'mind_map', '-t', '-A', '-F', '|', '-c', q],
    text=True,
)
from collections import defaultdict
by_user = defaultdict(set)
for line in out.splitlines():
    line = line.strip()
    if not line or '|' not in line:
        continue
    uid, rk, role = line.split('|')[:3]
    by_user[uid].add(rk)

users = list(by_user.items())
A = B = None
roomA = roomB = None
for i, (ua, ra) in enumerate(users):
    for ub, rb in users[i + 1 :]:
        onlyA, onlyB = ra - rb, rb - ra
        if onlyA and onlyB:
            A, B = ua, ub
            roomA, roomB = sorted(onlyA)[0], sorted(onlyB)[0]
            break
    if A:
        break
if not A:
    A, ra = users[0]
    B, rb = users[1]
    roomA, roomB = sorted(ra)[0], sorted(rb)[0]

C = None
for uid, rooms in users:
    if roomA in rooms and roomB in rooms:
        C = uid
        break

report = {'users': {'A': A, 'B': B, 'C': C}, 'rooms': {'A': roomA, 'B': roomB}}

know = root / 'knowledge'
for rid, marker in [(roomA, 'SECRET_A_MARKER'), (roomB, 'SECRET_B_MARKER')]:
    d = know / rid
    d.mkdir(parents=True, exist_ok=True)
    (d / 'README.md').write_text(f'# {rid}\n\n{marker}\n', encoding='utf-8')
    (d / 'manifest.json').write_text(
        json.dumps({'version': 1, 'roomId': rid, 'documents': [{'path': 'README.md'}]}, ensure_ascii=False),
        encoding='utf-8',
    )

def hash_tree(p: Path) -> str:
    h = hashlib.sha256()
    for f in sorted(p.rglob('*')):
        if f.is_file():
            h.update(str(f.relative_to(p)).replace('\\', '/').encode())
            h.update(f.read_bytes())
    return h.hexdigest()

hash_before = hash_tree(know)

# OpenWiki room runner
rooms_root = root / 'data' / 'openwiki' / 'rooms'
rooms_root.mkdir(parents=True, exist_ok=True)
e = os.environ.copy()
e['KNOWLEDGE_ROOT'] = str(know)
e['OPENWIKI_ROOMS_ROOT'] = str(rooms_root)
for rid, marker in [(roomA, 'SECRET_A_MARKER'), (roomB, 'SECRET_B_MARKER')]:
    subprocess.check_call(
        ['node', 'integrations/knowledge-mcp/src/openwiki-runner/cli.js', '--room', rid, '--marker', marker],
        env=e,
    )

hash_after = hash_tree(know)
report['canonicalHashUnchanged'] = hash_before == hash_after
report['canonicalHash'] = hash_before

def wiki_text(rid):
    wiki = rooms_root / rid / 'wiki'
    if not wiki.exists():
        return ''
    return '\n'.join(f.read_text(encoding='utf-8', errors='replace') for f in wiki.rglob('*.md'))

textA, textB = wiki_text(roomA), wiki_text(roomB)
report['openwikiIsolation'] = {
    'A_has_SECRET_A': 'SECRET_A_MARKER' in textA,
    'A_has_SECRET_B': 'SECRET_B_MARKER' in textA,
    'B_has_SECRET_B': 'SECRET_B_MARKER' in textB,
    'B_has_SECRET_A': 'SECRET_A_MARKER' in textB,
    'pass': (
        'SECRET_A_MARKER' in textA
        and 'SECRET_B_MARKER' not in textA
        and 'SECRET_B_MARKER' in textB
        and 'SECRET_A_MARKER' not in textB
    ),
}

tokA, tokB = mint(A), mint(B)
listA = call_tool(tokA, 'canonical_list', {})
listB = call_tool(tokB, 'canonical_list', {})

def rooms_of(payload):
    if isinstance(payload, dict) and 'error' in payload:
        return []
    if isinstance(payload, list):
        return sorted({x.get('roomId') for x in payload if isinstance(x, dict) and x.get('roomId')})
    if isinstance(payload, dict) and 'items' in payload:
        return sorted({x.get('roomId') for x in payload['items'] if x.get('roomId')})
    return []

roomsListedA, roomsListedB = rooms_of(listA), rooms_of(listB)
readB_as_A = call_tool(tokA, 'canonical_read', {'roomId': roomB, 'path': 'README.md'})
readA_as_A = call_tool(tokA, 'canonical_read', {'roomId': roomA, 'path': 'README.md'})
report['acl'] = {
    'A_list_rooms': roomsListedA,
    'B_list_rooms': roomsListedB,
    'A_sees_B': roomB in roomsListedA,
    'B_sees_A': roomA in roomsListedB,
    'A_read_B': readB_as_A,
    'A_read_A_ok': isinstance(readA_as_A, dict) and not readA_as_A.get('error') and (
        readA_as_A.get('roomId') == roomA or 'SECRET_A_MARKER' in json.dumps(readA_as_A)
    ),
}
report['aclPass'] = (
    roomB not in roomsListedA
    and roomA not in roomsListedB
    and (isinstance(readB_as_A, dict) and (readB_as_A.get('error') or readB_as_A.get('isError')))
    and report['acl']['A_read_A_ok']
)

# no/invalid token
try:
    rpc('invalid', 'tools/call', {'name': 'canonical_list', 'arguments': {}})
    report['noToken'] = 'accepted'
except Exception:
    report['noToken'] = 'rejected'

def one(label, tok, rid):
    return label, call_tool(tok, 'canonical_read', {'roomId': rid, 'path': 'README.md'})

futs = []
with concurrent.futures.ThreadPoolExecutor(4) as pool:
    futs.append(pool.submit(one, 'A', tokA, roomA))
    futs.append(pool.submit(one, 'B', tokB, roomB))
    if C:
        futs.append(pool.submit(one, 'C', mint(C), roomA))
    conc = [f.result() for f in futs]
report['concurrent'] = [
    {'user': u, 'hasError': bool(isinstance(r, dict) and r.get('error')), 'roomId': r.get('roomId') if isinstance(r, dict) else None}
    for u, r in conc
]

# cognee / allow from gateway config if readable
try:
    cfg = subprocess.check_output(
        ['docker', 'exec', 'mind-map-openclaw-gateway-1', 'cat', '/home/node/.openclaw/openclaw.json'],
        text=True,
    )
    cj = json.loads(cfg)
    report['cogneeSlot'] = ((cj.get('plugins') or {}).get('slots') or {}).get('memory')
    report['pluginsAllow'] = (cj.get('plugins') or {}).get('allow')
except Exception as ex:
    report['gatewayConfigError'] = str(ex)

outp = root / 'integrations' / 'openclaw' / 'phase2b' / 'PHASE2B_ACCEPTANCE.json'
outp.parent.mkdir(parents=True, exist_ok=True)
outp.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
print(json.dumps(report, indent=2, ensure_ascii=False))
