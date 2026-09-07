const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const h = require('./collabV2.pgHarness')
const storage = require('../bin/storage')
const { generateNKeysBetween, isValidPosition, isPaddedIndex } = require('../bin/fractionalIndex')

// Real PG and real V2 sockets; reconnect is a transport/hydrate check, not UI F5.
async function main() {
  const api = await h.tryPg()
  if (api.error) throw api.error
  const pool = api.getPool()
  const report = { cases: [], source: null }
  const sockets = []
  let server
  const rooms = []
  async function seed(rows, label) {
    const key = 'p0-persist-' + label + '-' + randomUUID()
    rooms.push(key)
    await pool.query("insert into rooms(room_key,title,cos_key,nodes,version) values($1,$2,$3,'{}',0)", [key, label, 'test/' + key])
    await pool.query(`insert into room_nodes(room_key,uid,parent_uid,position,data,is_root,node_version)
      select $1,x.uid,x.parent_uid,x.position,x.data,x.is_root,0
      from jsonb_to_recordset($2::jsonb) as x(uid text,parent_uid text,position text,data jsonb,is_root boolean)`, [key, JSON.stringify(rows)])
    return key
  }
  async function join(key) {
    const client = await h.joinClient(server.url, key, randomUUID())
    sockets.push(client.socket)
    assert.strictEqual(client.joined.ok, true, JSON.stringify(client.joined))
    return client
  }
  async function probe(key, parentUid, index, label, timed = false) {
    const before = (await pool.query('select uid,position from room_nodes where room_key=$1 and parent_uid=$2 and deleted_at is null order by position,uid', [key,parentUid])).rows
    const slot = index == null ? before.length : index
    const a = await join(key), b = await join(key)
    const uid = randomUUID()
    const { result } = await h.submitOp(a, 'node.insert', { uid, parentUid, index, text: 'P0_PERSIST_' + label })
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    const live = async () => (await pool.query('select * from room_nodes where room_key=$1 and uid=$2 and deleted_at is null', [key,uid])).rows[0]
    assert.ok(await live(), 'PG missing immediately after ACK')
    const deadline = Date.now() + 3000
    while (!b.events.some(e => JSON.stringify(e).includes(uid)) && Date.now() < deadline) await h.wait(10)
    assert.ok(JSON.stringify(result.operation).includes(uid), 'A ACK event missing')
    const received = b.events.find(e => JSON.stringify(e).includes(uid))
    assert.ok(received, 'B event missing')
    const event = received.event || received
    const payload = event.payload || {}
    const after = (await pool.query('select uid,position,parent_uid,node_version from room_nodes where room_key=$1 and parent_uid=$2 and deleted_at is null order by position,uid', [key,parentUid])).rows
    if (payload.siblingPositions) for (const [id, position] of Object.entries(payload.siblingPositions)) {
      assert.strictEqual(after.find(row => row.uid === id).position, position)
    }
    assert.strictEqual(after[slot].uid, uid, 'PG order differs from requested index')
    const entry = { label, roomKey:key, parentUid, uid, siblingCount:before.length, index:slot,
      left: before[slot-1]?.position || null, right:before[slot]?.position || null,
      leftPadded:isPaddedIndex(before[slot-1]?.position), rightPadded:isPaddedIndex(before[slot]?.position),
      reindex:!!payload.reindex, reindexCount:Object.keys(payload.siblingPositions || {}).length,
      newPosition:(await live()).position, pgAfterInsert:true, aEvent:true,bEvent:true,
      eventPositionMatchPg:true, revision:result.serverRevision }
    if (timed) {
      let elapsed = 0
      for (const second of [1,3,5]) { await h.wait((second-elapsed)*1000); elapsed=second; entry['pgT'+second]=!!(await live()); assert.ok(entry['pgT'+second]) }
    }
    a.socket.disconnect(); b.socket.disconnect()
    for (const who of ['A','B']) {
      const c = await join(key)
      const loaded = await storage.getRoomSnapshot(key)
      assert.ok(loaded.nodes[uid], who + ' hydrate omitted inserted node')
      assert.ok(loaded.nodes[parentUid].children.includes(uid))
      entry[who+'ReconnectHydrate'] = true
      c.socket.disconnect()
    }
    assert.ok(await live())
    const ops = await h.listAllOps(key)
    assert.ok(ops.some(op => op.operation_type === 'node.insert' && op.payload.uid === uid))
    entry.postInsertMapReplace = ops.some(op => Number(op.version)>result.serverRevision && op.operation_type==='map.replace')
    entry.pgAfterReconnect = true
    report.cases.push(entry)
    console.log('P0_CASE', JSON.stringify(entry))
  }
  try {
    server = await h.startV2Server()
    const source = (await pool.query("select room_key,uid from room_nodes where room_key not like 'p0-persist-%' and deleted_at is null and regexp_replace(data->>'text','<[^>]*>','','g')=$1 order by (select count(*) from room_nodes c where c.room_key=room_nodes.room_key and c.parent_uid=room_nodes.uid) desc limit 1", ['项目'])).rows[0]
    if (source) {
      const rows = (await pool.query('select * from room_nodes where room_key=$1 and deleted_at is null', [source.room_key])).rows
      const kids = rows.filter(r=>r.parent_uid===source.uid)
      const good = rows.find(r=>r.parent_uid===kids[0]?.uid && rows.some(c=>c.parent_uid===r.uid)) || kids.find(r=>rows.some(c=>c.parent_uid===r.uid))
      function stats(uid) {
        const children=rows.filter(r=>r.parent_uid===uid), positions=children.map(r=>r.position)
        // padded is LEGACY, not INVALID — keep fields distinct for reports.
        return {
          uid,
          children: children.length,
          emptyPositionCount: positions.filter(p => !p).length,
          duplicatePositionCount: positions.length - new Set(positions).size,
          legacyPaddedPositionCount: positions.filter(isPaddedIndex).length,
          invalidPositionCount: positions.filter(
            p => p && !isValidPosition(p) && !isPaddedIndex(p)
          ).length
        }
      }
      report.source={roomKey:source.room_key,bad:stats(source.uid),good:good && stats(good.uid)}
      console.log('P0_SOURCE',JSON.stringify(report.source))
      const key=await seed(rows,'source-copy')
      await probe(key,source.uid,undefined,'BAD',true)
      if(good) await probe(key,good.uid,undefined,'GOOD',true)
    }
    for (const count of [5,20,50,100,200,500]) for (const mode of ['canonical','padded','duplicate','empty']) for (const action of ['append','middle','first','last']) {
      const keys=generateNKeysBetween(null,null,count)
      const rows=[{uid:'root',parent_uid:null,position:keys[0],data:{uid:'root',text:'Root'},is_root:true}]
      for(let i=0;i<count;i++) rows.push({uid:'n'+i,parent_uid:'root',position:mode==='canonical'?keys[i]:mode==='padded'?String(i).padStart(8,'0'):mode==='empty'?'':keys[0],data:{uid:'n'+i,text:'Node'},is_root:false})
      const key=await seed(rows,count+'-'+mode+'-'+action)
      await probe(key,'root',action==='append'?undefined:action==='middle'?Math.floor(count/2):action==='first'?0:count,count+'-'+mode+'-'+action)
    }
  } finally {
    sockets.forEach(s=>s.disconnect())
    if(server) { if(server.presence?.close) server.presence.close(); server.server.close() }
    fs.mkdirSync(path.join(__dirname,'reports'),{recursive:true})
    fs.writeFileSync(path.join(__dirname,'reports/p0-persistence.json'),JSON.stringify(report,null,2))
    await pool.end()
  }
}
main().then(()=>process.exit(0)).catch(err=>{console.error(err);process.exit(1)})
