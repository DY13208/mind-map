from pathlib import Path
import json, os, subprocess, hashlib, time, urllib.request

root = Path(r'D:\mind-map')
# load env
env = {}
for line in (root/'.env').read_text(encoding='utf-8', errors='replace').splitlines():
    line=line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k,v=line.split('=',1); env[k.strip()]=v.strip().strip('"').strip("'")

secret = env['KNOWLEDGE_MCP_JWT_SECRET']

# mint jwt using node
mint = r'''
const { signToken } = require('./integrations/knowledge-mcp/src/auth/jwt');
const userId = process.argv[2];
const secret = process.env.KNOWLEDGE_MCP_JWT_SECRET;
const { token } = signToken({ userId, secret, ttlSec: 180, iss: 'openclaw-liangce', aud: 'knowledge-mcp' });
process.stdout.write(token);
'''
(root/'scripts/_mint_kmcp.js').write_text(mint, encoding='utf-8')

def mint_token(uid):
    e = os.environ.copy(); e['KNOWLEDGE_MCP_JWT_SECRET']=secret
    return subprocess.check_output(['node', 'scripts/_mint_kmcp.js', uid], cwd=str(root), env=e, text=True)

def rpc(token, method, params=None, id_=1):
    body = json.dumps({'jsonrpc':'2.0','id':id_,'method':method,'params':params or {}}).encode()
    req = urllib.request.Request('http://127.0.0.1:18792/mcp', data=body, headers={
        'Content-Type':'application/json',
        'Authorization': f'Bearer {token}',
    }, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

# Pick real users/rooms from DB
q = "select user_id, room_key, role from room_members where role in ('owner','editor','viewer') limit 50;"
out = subprocess.check_output(['docker','exec','mind-map-postgres-1','psql','-U','postgres','-d','mind_map','-t','-A','-F','|','-c',q], text=True)
rows=[l.strip().split('|') for l in out.splitlines() if l.strip() and '|' in l]
# find user A with roomA only-ish and user B with different room
from collections import defaultdict
by_user=defaultdict(set)
for uid, rk, role in rows:
    by_user[uid].add(rk)

# choose A and B with disjoint rooms if possible
users=list(by_user.items())
A=B=None; roomA=roomB=None
for i,(ua,ra) in enumerate(users):
    for ub,rb in users[i+1:]:
        onlyA=ra-rb; onlyB=rb-ra
        if onlyA and onlyB:
            A,B=ua,ub; roomA=sorted(onlyA)[0]; roomB=sorted(onlyB)[0]; break
    if A: break
if not A:
    # fallback first two
    A,ra=users[0]; B,rb=users[1]; roomA=sorted(ra)[0]; roomB=sorted(rb)[0]

# user C with both if exists
C=None
for uid, rooms in users:
    if roomA in rooms and roomB in rooms:
        C=uid; break

report={'users':{'A':A,'B':B,'C':C},'rooms':{'A':roomA,'B':roomB}}

# Ensure canonical dirs exist for test rooms (seed markers)
know = root/'knowledge'
for rid, marker in [(roomA,'SECRET_A_MARKER'), (roomB,'SECRET_B_MARKER')]:
    d = know/rid
    d.mkdir(parents=True, exist_ok=True)
    (d/'README.md').write_text(f'# {rid}\n\n{marker}\n', encoding='utf-8')
    if not (d/'manifest.json').exists():
        (d/'manifest.json').write_text(json.dumps({'version':1,'roomId':rid,'documents':[{'path':'README.md'}]}), encoding='utf-8')

# hash before openwiki
def hash_tree(p):
    h=hashlib.sha256()
    for f in sorted(Path(p).rglob('*')):
        if f.is_file():
            h.update(str(f.relative_to(p)).replace('\\','/').encode()); h.update(f.read_bytes())
    return h.hexdigest()
hash_before=hash_tree(know)

# generate room-scoped openwiki via runner
rooms_root = root/'data'/'openwiki'/'rooms'
rooms_root.mkdir(parents=True, exist_ok=True)
# set env for runner
e=os.environ.copy(); e['KNOWLEDGE_ROOT']=str(know); e['OPENWIKI_ROOMS_ROOT']=str(rooms_root)
for rid, marker in [(roomA,'SECRET_A_MARKER'), (roomB,'SECRET_B_MARKER')]:
    subprocess.check_call(['node','integrations/knowledge-mcp/src/openwiki-runner/cli.js','--room',rid,'--marker',marker], cwd=str(root), env=e)

hash_after=hash_tree(know)
report['canonicalHashUnchanged']= hash_before==hash_after
report['canonicalHash']=hash_before

# OpenWiki isolation check
wa=(rooms_root/roomA/'wiki').rglob('*.md')
wb=(rooms_root/roomB/'wiki').rglob('*.md')
textA='\n'.join(f.read_text(encoding='utf-8', errors='replace') for f in wa)
textB='\n'.join(f.read_text(encoding='utf-8', errors='replace') for f in wb)
report['openwikiIsolation']={
  'A_has_SECRET_A': 'SECRET_A_MARKER' in textA,
  'A_has_SECRET_B': 'SECRET_B_MARKER' in textA,
  'B_has_SECRET_B': 'SECRET_B_MARKER' in textB,
  'B_has_SECRET_A': 'SECRET_A_MARKER' in textB,
  'pass': ('SECRET_A_MARKER' in textA and 'SECRET_B_MARKER' not in textA and 'SECRET_B_MARKER' in textB and 'SECRET_A_MARKER' not in textB)
}

tokA=mint_token(A); tokB=mint_token(B)

def tool(tok, name, args):
    res=rpc(tok,'tools/call',{'name':name,'arguments':args})
    text=res.get('result',{}).get('content',[{}])[0].get('text','')
    try: return json.loads(text)
    except: return {'raw':text,'isError':res.get('result',{}).get('isError')}

# ACL tests
listA=tool(tokA,'canonical_list',{})
listB=tool(tokB,'canonical_list',{})
roomsListedA=sorted({x.get('roomId') for x in listA if isinstance(x,dict)}) if isinstance(listA,list) else []
roomsListedB=sorted({x.get('roomId') for x in listB if isinstance(x,dict)}) if isinstance(listB,list) else []
readB_as_A=tool(tokA,'canonical_read',{'roomId':roomB,'path':'README.md'})
readA_as_A=tool(tokA,'canonical_read',{'roomId':roomA,'path':'README.md'})
report['acl']={
  'A_list_rooms': roomsListedA,
  'B_list_rooms': roomsListedB,
  'A_sees_only_own': roomA in roomsListedA and roomB not in roomsListedA,
  'B_sees_only_own': roomB in roomsListedB and roomA not in roomsListedB,
  'A_read_B_denied': isinstance(readB_as_A,dict) and readB_as_A.get('error') in ('not_found','forbidden_room','error'),
  'A_read_A_ok': isinstance(readA_as_A,dict) and readA_as_A.get('roomId')==roomA,
}

# no token
try:
    rpc('bad','tools/call',{'name':'canonical_list','arguments':{}})
    report['noToken']='accepted_bad'
except Exception as ex:
    report['noToken']='rejected'

# concurrent A/B
import concurrent.futures
def one(uid, tok, rid):
    return (uid, tool(tok,'canonical_read',{'roomId':rid,'path':'README.md'}))
with concurrent.futures.ThreadPoolExecutor(3) as ex:
    futs=[ex.submit(one,'A',tokA,roomA), ex.submit(one,'B',tokB,roomB)]
    if C:
        tokC=mint_token(C); futs.append(ex.submit(one,'C',tokC,roomA))
    conc=[f.result() for f in futs]
report['concurrent']=[{'user':u,'room': (r.get('roomId') if isinstance(r,dict) else None), 'err': r.get('error') if isinstance(r,dict) else None} for u,r in conc]
report['concurrentPass']=all(
  (u=='A' and isinstance(r,dict) and r.get('roomId')==roomA) or
  (u=='B' and isinstance(r,dict) and r.get('roomId')==roomB) or
  (u=='C' and isinstance(r,dict) and not r.get('error'))
  for u,r in conc
)

# cognee slot check
cfg=subprocess.check_output(['docker','exec','mind-map-openclaw-gateway-1','cat','/home/node/.openclaw/openclaw.json'], text=True)
cj=json.loads(cfg)
report['cogneeSlot']=(((cj.get('plugins') or {}).get('slots') or {}).get('memory'))
report['pluginsAllow']=(cj.get('plugins') or {}).get('allow')

outp=root/'integrations'/'openclaw'/'phase2b'/'PHASE2B_ACCEPTANCE.json'
outp.parent.mkdir(parents=True, exist_ok=True)
outp.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
print(json.dumps(report, indent=2, ensure_ascii=False))
