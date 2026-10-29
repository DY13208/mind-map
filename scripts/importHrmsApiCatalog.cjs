const fs=require('fs'),path=require('path')
const input=fs.readFileSync(process.argv[2],'utf8')
let moduleName='',items=[]
for(const line of input.split(/\r?\n/)){
 const heading=line.match(/^### `([^`]+)`/);if(heading){moduleName=heading[1];continue}
 const row=line.match(/^\| `([^`]+)` \| ([^|]*)\| ([^|]*)\|([^|]*)\|/)
 if(!row || !moduleName)continue
 const [,name,params,http]=row
 let policy='manual',reason='需在页面人工办理或使用专用业务工具'
 if(/^(?:get_|list_|search_|preview_|workspace_stats$)/.test(name) || name==='resolve_hrbp') {policy='read';reason='按当前用户及人事系统权限查询'}
 else if(/^(?:create_|update_|save_|start_|mark_|move_|cancel_|retry_|import_)/.test(name)){policy='write';reason='先展示本次参数，用户明确确认后执行'}
 if(/callback|oauth|sso|issue_token|password|bind_my|update_my_login|send_test|provision_|run_contact|bind_existing|assets|configure_fadada|seal_authorization|sign_url|template_edit_url/.test(moduleName+'.'+name)){policy='internal';reason='登录、凭据、回调或基础设施接口，不供Agent直接调用'}
 if(/delete_|confirm_onboarding|confirm_offboarding|confirm_probation|complete_approval_task|assign_business|save_role_menu|create_business_role|save_form_design|save_template_design|save_approval|use_approval_template|start_offboarding|signature_base64|import_org_units|move_org_members|update_org_person|create_org_unit|update_employee_fields|save_employee_|create_employee_account|payroll|create_attendance|upload_|download_|stream_file|preview_file|save_my_signature/.test(moduleName+'.'+name)){policy='manual';reason='涉及人工审批、主档、权限、签署、删除、工资或文件传输，保留人工或专用工具入口'}
 if(moduleName.includes('.contract') && policy!=='read'){policy='manual';reason='合同及签署操作需在专用流程中办理'}
 if(moduleName.endsWith('.approval_import')){policy='manual';reason='使用approval_request正式流程及其已通过同步队列，不能绕过原审批导入'}
 if(/import_offboarding|import_archive_zip|save_contract_attachment|update_my_email|get_my_signature/.test(name)){policy='manual';reason='涉及人事批量写入、个人凭据或文件，保留人工或专用流程入口'}
 if(/authorize_url|get_web_login_config|org_import_template|archive_export/.test(name)){policy='internal';reason='授权或下载入口，不作为业务数据查询'}
 const names=params.trim()==='—'?[]:params.split(',').map(s=>s.trim()).filter(Boolean)
 items.push({id:moduleName+'.'+name,module:moduleName,name,params:names,http:http.trim(),policy,reason})
}
if(!items.length || new Set(items.map(i=>i.id)).size!==items.length)throw Error('Invalid/duplicate HRMS API catalog')
const out=path.resolve(__dirname,'../simple-mind-map/bin/hrmsAgent/catalog.json')
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(items,null,2)+'\n')
console.log(JSON.stringify({count:items.length,policies:items.reduce((a,i)=>(a[i.policy]=(a[i.policy]||0)+1,a),{})}))
