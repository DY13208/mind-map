const assert = require('assert/strict')
const fs = require('fs'), path = require('path'), Module = require('module')
const esbuild = require('esbuild'), compiler = require('vue-template-compiler')
async function main() {
  const root = path.resolve(__dirname, '..')
  const built = await esbuild.build({stdin:{resolveDir:root,contents:"export { default as Dialog } from './src/pages/ProductShell/components/ShareFolderDialog.vue';export {setProductHttp} from './src/services/productHttp';export {normalizeMemberDto,normalizeRoomDto} from './src/services/roomDto';"},bundle:true,write:false,platform:'node',format:'cjs',alias:{'@':path.join(root,'src')},plugins:[{name:'sfc-script',setup(b){b.onLoad({filter:/\.vue$/},a=>({contents:compiler.parseComponent(fs.readFileSync(a.path,'utf8')).script.content,resolveDir:path.dirname(a.path),loader:'js'}));b.onLoad({filter:/src\/utils\/auth\.js$/},()=>({contents:'export const getCurrentUser=()=>({id:"owner"})',loader:'js'}))}}]})
  const mod = new Module(__filename, module);mod.paths=module.paths;mod._compile(built.outputFiles[0].text,__filename)
  const {Dialog,setProductHttp,normalizeMemberDto,normalizeRoomDto}=mod.exports
  const Vue = require('vue'), C = Vue.extend(Dialog), writes=[]
  const contacts=Array.from({length:24},(_,i)=>({id:'id-'+i,userId:'wx-'+i,wecomUserId:'wx-'+i,name:'成员'+i,departmentIds:[i<12?'1':'2']}))
  let rows=[{user_id:'owner',name:'所有者',role:'owner'},...contacts.slice(0,14).map((c,i)=>({user_id:c.id,wecom_userid:c.userId,name:c.name,role:i===0?'manager':i===1?'editor':'viewer'}))].map(normalizeMemberDto)
  const vm=new C({propsData:{visible:false,folder:{id:'folder',owner:{id:'owner'}}}})
  const messages=[];vm.$message={info:m=>messages.push(m),success:m=>messages.push(m),error:m=>messages.push(m),warning:m=>messages.push(m)}
  setProductHttp(async(url,options={})=>{
    if(url.startsWith('/api/wecom/contacts')){const dep=new URL(url,'http://local').searchParams.get('departmentId');const list=contacts.filter(c=>!dep||c.departmentIds.includes(dep));return {list,total:list.length}}
    if(options.method==='POST'){writes.push(JSON.parse(options.body));return {list:rows,changed:1}}
    return {list:rows}
  })
  vm.departmentOptions=[{id:'1',parentId:'0',name:'总部'},{id:'2',parentId:'1',name:'下属部门'}]
  vm.contacts=contacts;vm.loadedDepartmentIds=['1','2'];vm.departmentTotals={'1':12,'2':12};vm.members=rows;vm.role=vm.defaultRole
  assert.equal(vm.role,'Manager');assert.equal(vm.canTransferOwnership,true)
  assert.deepEqual(vm.roleFilters.map(f=>f.count),[15,12,1,1,1])
  const row={type:'member',id:'wx-0',contact:contacts[0],name:contacts[0].name}
  assert.equal(vm.rowPermission(row).tone,'manager');assert.equal(vm.isRowSelected(row),false)
  await vm.toggleRow(row,true);assert.equal(vm.isRowSelected(row),true);assert.equal(vm.members[1].role,'Manager')
  await vm.grantSelected();assert.equal(writes.length,0);assert.match(messages.pop(),/无需保存/)
  await vm.toggleRow({type:'member',id:'wx-1',contact:contacts[1]},true)
  await vm.grantSelected();assert.deepEqual(writes[0].userIds,['wx-1']);assert.equal(writes[0].onlyChanges,true)
  await vm.toggleRow({type:'department',id:'1'},true);assert.equal(vm.selectedUserIds.length,24)
  await vm.toggleRow(row,false);assert.deepEqual(vm.selectedDepartmentIds,[]);assert.equal(vm.selectedUserIds.length,23);assert.equal(vm.isDepartmentPartial('1'),true)
  vm.clearSelection();await vm.toggleRow({type:'department',id:'1'},true)
  vm.includeChildren=false;await Vue.nextTick();await new Promise(resolve=>setImmediate(resolve));assert.equal(vm.selectedUserIds.length,12)
  vm.autoSelectMembers=false;vm.clearSelection();await vm.toggleRow({type:'department',id:'1'},true);assert.equal(vm.selectedUserIds.length,0);assert.deepEqual(vm.selectedDepartmentIds,['1'])
  vm.page=2;vm.roleFilter='viewer';await Vue.nextTick();assert.equal(vm.page,1);assert.equal(vm.filteredMembers.length,12)
  vm.memberQuery='成员13';await Vue.nextTick();assert.equal(vm.filteredMembers.length,1);vm.roleFilter='manager';await Vue.nextTick();assert.equal(vm.filteredMembers.length,0)
  vm.$props.resourceType='room';vm.members=[normalizeMemberDto({user_id:'id-0',wecom_userid:'wx-0',role:'editor',direct_role:null,folder_role:'editor'})];vm.role='Editor'
  assert.equal(vm.isInheritedOnly(vm.members[0]),true);assert.equal(vm.needsRoleChange(vm.members[0]),true,'Direct grant differs from inherited access')
  assert.equal(normalizeRoomDto({room_key:'room',role:'manager'}).canManage,true)
  const inherited = vm.members[0]
  assert.equal(vm.editableMemberRole(inherited),'','Pure inheritance is not a direct grant')
  assert.equal(vm.editableMemberRole({...inherited,directRole:'viewer'}),'Viewer','Normalize backend role casing to UI options')
  let patchCount=0
  const patched={user_id:'id-0',role:'editor',direct_role:'viewer',folder_role:'editor'}
  setProductHttp(async (url, options={})=>{if(options.method==='PATCH'){patchCount++;return patched}if(options.method==='DELETE'){patched.direct_role=null;return {ok:true}}return {list:[patched]}})
  await vm.updateRole(inherited,'Viewer')
  assert.equal(patchCount,1)
  assert.equal(vm.members[0].directRole,'viewer')
  assert.equal(vm.members[0].role,'Editor')
  assert.match(messages.pop(),/继承权限/)
  await vm.updateRole(vm.members[0],'Viewer')
  assert.equal(patchCount,1,'Unchanged direct grant must not submit again')
  vm.$props.readOnly=true
  await vm.updateRole(vm.members[0],'Editor')
  assert.equal(patchCount,1,'Read-only mode must not submit mutations')
  vm.$props.readOnly=false
  await vm.remove(vm.members[0])
  assert.equal(vm.members[0].directRole,null)
  assert.equal(vm.members[0].role,'Editor')
  assert.match(messages.pop(),/直接授权已移除/,'Explain remaining inherited access after removal')
  const template=compiler.parseComponent(fs.readFileSync(path.join(root,'src/pages/Edit/components/CooperateDialog.vue'),'utf8')).template.content
  assert.deepEqual(compiler.compile(template).errors,[])
  assert.match(template,/<ShareFolderDialog/)
  assert(!template.includes('changeMemberRole'))
  const sharedTemplate=compiler.parseComponent(fs.readFileSync(path.join(root,'src/pages/ProductShell/components/ShareFolderDialog.vue'),'utf8')).template.content
  assert.deepEqual(compiler.compile(sharedTemplate).errors,[])
  // Late reads from a closed/switched dialog must not replace current ACL data.
  let resolveRead;setProductHttp(()=>new Promise(resolve=>{resolveRead=resolve}));const pending=vm.loadMembers();vm.loadVersion++;const current=vm.members;resolveRead({list:[{user_id:'stale',role:'owner'}]});await pending;assert.equal(vm.members,current)
  vm.$destroy();setProductHttp(null)
  console.log('Permission dialog checks passed: defaults, identity badges, independent selection, no-op/delta saves, department scope/half state, filters/pagination, inheritance, stale reads')
}
main().catch(e=>{console.error(e);process.exitCode=1})
