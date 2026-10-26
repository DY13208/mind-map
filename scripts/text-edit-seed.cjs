'use strict'
const assert = require('node:assert/strict')
assert.equal(process.env.MIND_MAP_SKIP_ROOT_ENV, '1')
assert.match(process.env.PGDATABASE || '', /^mcp_guards_test_[a-f0-9]{12}$/)
const storage = require('../simple-mind-map/bin/storage')
process.once('message', async ({roomKey, userIds}) => {
  try {
    const nodes = { root: { isRoot:true, data:{uid:'root',text:'文字编辑隔离测试',expand:true},children:['other'] }, other:{data:{uid:'other',text:'点击此节点结束编辑'},children:[]} }
    await storage.upsertRoom(roomKey, '文字编辑隔离测试', {nodes,allowFullTree:true})
    const pool = storage.getPool()
    for (const userId of userIds) await pool.query("insert into room_members(room_key,user_id,role,direct_role,source) values($1,$2,'owner','owner','direct_share')",[roomKey,userId])
    process.send({ok:true})
    await pool.end()
  } catch(error) {process.send({error:error.message})}
  finally {process.disconnect()}
})
