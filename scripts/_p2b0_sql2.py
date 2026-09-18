import sqlite3, json, os
p=r'integrations/openclaw/phase2b0/agent-openclaw.sqlite'
con=sqlite3.connect(p)
cur=con.cursor()
# Find p2b0 sessions
rows=cur.execute("select session_key, substr(entry_json,1,2000), created_actor_type, created_actor_id, owner_actor_type, owner_actor_id from session_nodes where session_key like '%p2b0%' or entry_json like '%p2b0%'").fetchall()
print('session_nodes hits', len(rows))
for r in rows:
  print('KEY', r[0])
  print('created', r[2], r[3], 'owner', r[4], r[5])
  try:
    ej=json.loads(r[1]+ ('}' if not r[1].endswith('}') else ''))
  except Exception:
    ej=None
  # print identity-ish keys from full entry
  full=cur.execute('select entry_json from session_nodes where session_key=?',(r[0],)).fetchone()[0]
  data=json.loads(full)
  def walk(o,pref=''):
    if isinstance(o,dict):
      for k,v in o.items():
        lk=k.lower()
        if any(x in lk for x in ['sender','user','request','identity','channel','actor','owner','profile']):
          print(' ',pref+k, '=', json.dumps(v,ensure_ascii=False)[:300])
        if isinstance(v,(dict,list)) and len(pref)<40:
          walk(v,pref+k+'.')
    elif isinstance(o,list) and len(o)<=20:
      for i,v in enumerate(o[:5]):
        walk(v,pref+f'[{i}].')
  walk(data)
  print('---')

parts=cur.execute("select * from session_participants where session_key like '%p2b0%'").fetchall()
print('participants', parts)
# Also recent session_keys
recent=cur.execute("select session_key, created_actor_type, created_actor_id, owner_actor_type, owner_actor_id, updated_at from session_nodes order by updated_at desc limit 15").fetchall()
print('recent keys:')
for r in recent: print(r)
con.close()

# audit events for sender
sp=r'integrations/openclaw/phase2b0/state-openclaw.sqlite'
con=sqlite3.connect(sp)
cur=con.cursor()
aud=cur.execute("select occurred_at, kind, action, actor_type, actor_id, session_key, channel from audit_events where session_key like '%p2b0%' or session_key like '%userA%' or session_key like '%userB%' order by sequence desc limit 20").fetchall()
print('audit', aud)
# generic recent audits with actor
aud2=cur.execute("select occurred_at, kind, action, actor_type, actor_id, session_key, channel from audit_events order by sequence desc limit 15").fetchall()
print('recent audit:')
for a in aud2: print(a)
con.close()
