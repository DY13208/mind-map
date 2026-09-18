import sqlite3, json
p=r'integrations/openclaw/phase2b0/agent-openclaw.sqlite'
con=sqlite3.connect(p); cur=con.cursor()
# Copy wal/shm maybe stale - re-copy live DB
print('search openai-user p2b0')
for row in cur.execute("select session_key, created_actor_type, created_actor_id, owner_actor_type, owner_actor_id, updated_at from session_nodes where session_key like '%p2b0%' or session_key like '%openai-user%' order by updated_at desc limit 30"):
  print(row)
# dump one openai-user entry_json identity fields
row=cur.execute("select session_key, entry_json from session_nodes where session_key like '%openai-user:conv:p2b0%' order by updated_at desc limit 1").fetchone()
if not row:
  row=cur.execute("select session_key, entry_json from session_nodes where session_key like '%openai-user%' order by updated_at desc limit 1").fetchone()
print('sample key', row[0] if row else None)
if row:
  data=json.loads(row[1])
  print(json.dumps({k:data.get(k) for k in data.keys() if any(x in k.lower() for x in ['sender','user','request','identity','channel','actor','owner','profile','origin','chat'])}, ensure_ascii=False, indent=2)[:4000])
  # also top-level keys
  print('top keys', sorted(data.keys())[:80])
con.close()
