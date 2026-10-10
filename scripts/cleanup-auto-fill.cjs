// Explicit one-room maintenance through the authenticated collaboration API.
const crypto=require('node:crypto')
const {cleanupNodes}=require('../simple-mind-map/src/utils/fillFacts')
async function main() {
  const room=process.argv[process.argv.indexOf('--room')+1]
  if(!process.argv.includes('--room') || !room || room.startsWith('--'))throw new Error('必须指定 --room；默认仅预览，--apply 才清理')
  const base=process.env.CLEANUP_API_BASE || 'http://127.0.0.1:1234'
  const origin=process.env.AUTH_APP_ORIGIN || base
  const login=await fetch(base+'/api/auth/dev-login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({key:process.env.AUTH_DEV_BYPASS_KEY})})
  if(!login.ok)throw new Error('登录失败：'+login.status)
  const headers={Origin:origin,Cookie:login.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'}
  async function request(path,body) {
    const response=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined})
    const data=await response.json();if(!response.ok)throw new Error(data.error||String(response.status));return data
  }
  const snapshot=await request('/api/files/'+encodeURIComponent(room)+'?format=full&max_nodes=10000')
  if(snapshot.truncated||!snapshot.tree)throw new Error('脑图未完整读取，停止清理')
  const nodes=[]
  function walk(tree,parentId=null){nodes.push({uid:tree.data.uid,parentId,data:tree.data});for(const child of tree.children||[])walk(child,tree.data.uid)}
  walk(snapshot.tree)
  const plan=cleanupNodes(nodes),byId=new Map(nodes.map(n=>[n.uid,n]))
  console.log(JSON.stringify({room,title:snapshot.title,deletes:plan.deletes.length,updates:plan.updates.length,preserved:plan.preserved,preview:plan.deletes.map(uid=>byId.get(uid).data.text)}))
  if(!process.argv.includes('--apply')||!plan.deletes.length&&!plan.updates.length)return
  const backup=await request('/api/files/'+encodeURIComponent(room)+'/versions',{name:'补齐清理前备份',description:'清理自动补齐空节点、重复事实和自动备注前保存'})
  const version=await request('/api/maps/'+encodeURIComponent(room)+'/version')
  if(Number(version.version ?? version.revision)!==Number(snapshot.version))throw new Error('脑图已有新编辑，已备份但停止清理，请重新预览')
  const ops=[...plan.updates.map(u=>({type:'node.update',payload:{uid:u.uid,patch:u.data,expected:{text:byId.get(u.uid).data.text,note:byId.get(u.uid).data.note}}})),...plan.deletes.map(uid=>({type:'node.delete',payload:{uid,expected:{text:byId.get(uid).data.text,note:byId.get(uid).data.note},expectedLeaf:true}}))]
  if(ops.length>1000)throw new Error('超过单次清理上限，未执行')
  const opId=crypto.randomUUID()
  const result=await request('/api/collab-v2/op',{roomKey:room,opId,clientId:'auto-fill-cleanup',baseRevision:snapshot.version,type:'node.batch',payload:{ops}})
  console.log(JSON.stringify({applied:true,opId,revision:result.serverRevision,backupVersionId:backup.version?.id||backup.version?.versionId}))
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
