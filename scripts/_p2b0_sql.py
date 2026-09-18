import sqlite3, json, os
base=r'integrations/openclaw/phase2b0'
for name in ['state-openclaw.sqlite','agent-openclaw.sqlite']:
  p=os.path.join(base,name)
  print('\n====',name,'size',os.path.getsize(p))
  con=sqlite3.connect(p)
  cur=con.cursor()
  tables=cur.execute("select name from sqlite_master where type='table'").fetchall()
  print('tables', [t[0] for t in tables][:40])
  for (t,) in tables:
    cols=cur.execute(f'pragma table_info({t})').fetchall()
    colnames=[c[1] for c in cols]
    interesting=[c for c in colnames if any(k in c.lower() for k in ['sender','user','request','session','identity','channel','agent'])]
    if interesting or t.lower() in ('sessions','messages','runs','turns','chat'):
      print(f'  {t}: {colnames[:20]}')
  # search p2b0
  for (t,) in tables:
    cols=[c[1] for c in cur.execute(f'pragma table_info({t})').fetchall()]
    for col in cols:
      try:
        rows=cur.execute(f'select * from {t} where cast({col} as text) like ? limit 5', ('%p2b0-user%',)).fetchall()
        if rows:
          print('HIT', t, col, 'n=',len(rows))
          print(' sample cols', cols)
          print(' sample row', rows[0][:12])
      except Exception:
        pass
  con.close()
