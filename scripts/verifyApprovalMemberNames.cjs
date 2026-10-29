const assert=require('node:assert/strict'),{findMembers,chineseName}=require('../simple-mind-map/bin/leaveWorkflow/memberNames')
let members=[{corp:'one',user_id:'henry',name:'黄贤润Henry'},{corp:'two',user_id:'other-corp',name:'黄贤润'}]
const db={query:async(sql,[corp,name])=>({rows:members.filter(m=>m.corp===corp&&(sql.includes('left(name')?m.name.startsWith(name):m.name===name)).map(({user_id,name})=>({user_id,name}))})}
async function main(){
 assert.equal(chineseName('黄贤润Henry'),'黄贤润')
 assert.equal(chineseName('黄贤润（Henry）'),'黄贤润')
 assert.equal(chineseName('黄贤润 其他人'),'')
 assert.deepEqual((await findMembers(db,'one','黄贤润')).map(m=>m.user_id),['henry'])
 assert.equal((await findMembers(db,'one','贤润')).length,0)
 assert.equal((await findMembers(db,'one','黄贤润甲')).length,0)
 members.push({corp:'one',user_id:'another',name:'黄贤润George'})
 assert.equal((await findMembers(db,'one','黄贤润')).length,2)
 assert.deepEqual((await findMembers(db,'one','黄贤润Henry')).map(m=>m.user_id),['henry'])
 members.push({corp:'one',user_id:'duplicate',name:'黄贤润Henry'})
 assert.equal((await findMembers(db,'one','黄贤润Henry')).length,2)
 console.log('PASS: exact and bilingual names, company isolation, no substring guessing, duplicate ambiguity')
}
main().catch(e=>{console.error(e);process.exitCode=1})
