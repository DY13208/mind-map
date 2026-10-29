module.exports = function naturalApproval(prefix='natural') {
  const nodes=[]
  const add=(parent,text,uid=prefix+'-'+nodes.length)=>{nodes.push({uid,parent_uid:parent,position:String(nodes.length).padStart(5,'0'),data:{text}});return uid}
  const root=add(null,'补贴申请',prefix+'-root')
  const requirements=add(root,'提交要求')
  const field=(name,value)=>{const uid=add(requirements,name);add(uid,value);return uid}
  field('补贴月份','2026-10');field('补贴金额','55');field('申请说明','隔离测试加班补贴')
  const ssc=add(root,'SSC')
  add(ssc,'默认同意')
  const reject=add(ssc,'以下情况拒绝');add(reject,'虚假打卡');add(reject,'加班时间不在补贴申请内');add(reject,'补贴金额错误')
  const confirm=add(ssc,'须确认');const truth=add(confirm,'加班真实性')
  const cc=add(root,'抄送');add(cc,'老板')
  const config=add(root,'审批配置'),role=add(config,'SSC');add(role,'账号：ssc')
  const ccConfig=add(config,'抄送'),boss=add(ccConfig,'老板');add(boss,'账号：ceo')
  return {root,nodes,ssc,truth,requirements}
}
